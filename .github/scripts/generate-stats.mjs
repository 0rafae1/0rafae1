#!/usr/bin/env node
/**
 * Generates assets/github-stats.svg and assets/github-langs.svg for a GitHub
 * profile README, using two calls to the GitHub GraphQL API instead of one
 * REST call per repository.
 *
 * Required env vars:
 *   GH_TOKEN    - any valid GitHub token (the default GITHUB_TOKEN is enough,
 *                 since everything queried here is public data)
 *   GH_USERNAME - the GitHub username to report on
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const TOKEN = process.env.GH_TOKEN;
const USERNAME = process.env.GH_USERNAME;

if (!TOKEN || !USERNAME) {
  console.error("Missing GH_TOKEN or GH_USERNAME environment variables.");
  process.exit(1);
}

const API_URL = "https://api.github.com/graphql";

function logRateLimit(res) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");

  if (remaining !== null) {
    console.log(`Rate limit: ${remaining}/${limit} points remaining this hour`);
    if (Number(remaining) < 50) {
      console.log(`::warning::GitHub API rate limit is low (${remaining}/${limit} left this hour).`);
    }
  }
}

async function graphql(query, variables = {}, attempt = 1) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "github-profile-stats-script",
    },
    body: JSON.stringify({ query, variables }),
  });

  logRateLimit(res);

  if (!res.ok) {
    const isAuthError = res.status === 401 || res.status === 403;
    if (!isAuthError && attempt < 3) {
      console.warn(`GraphQL request failed (HTTP ${res.status}), retrying in ${attempt * 2}s...`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
      return graphql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL returned errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Single call: owned public repos (stars, forks, languages), total PRs,
// total issues, "contributed to" count, and the list of years the user has
// contributed in (needed for the second call below).
const MAIN_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionYears
      }
      repositoriesContributedTo(
        first: 1
        contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      ) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      issues(first: 1) {
        totalCount
      }
      repositories(
        first: 100
        ownerAffiliations: OWNER
        isFork: false
        orderBy: { direction: DESC, field: STARGAZERS }
      ) {
        nodes {
          name
          stargazers {
            totalCount
          }
          forkCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

// Second call: total commits, summed across every contribution year. GitHub
// only reports totalCommitContributions for a bounded from/to window, so we
// ask for every year at once using aliases (one HTTP request either way).
function yearsQuery(years) {
  const parts = years.map(
    (y) => `
      year${y}: contributionsCollection(
        from: "${y}-01-01T00:00:00Z"
        to: "${Number(y) + 1}-01-01T00:00:00Z"
      ) {
        totalCommitContributions
        restrictedContributionsCount
      }
    `
  );
  return `query ($login: String!) { user(login: $login) { ${parts.join("\n")} } }`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const LANG_COLORS = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Python: "#3572A5",
  Java: "#b07219",
  PHP: "#4F5D95",
  Ruby: "#701516",
  "C++": "#f34b7d",
  C: "#555555",
  Shell: "#89e051",
  Dockerfile: "#384d54",
  Vue: "#4fc08d",
};

// --- Template-based rendering -----------------------------------------
// Loads the Figma-exported SVG templates and swaps values/colors/widths by
// element id, leaving every other path (labels, icons, background) exactly
// as designed in Figma.

const STATS_TEMPLATE_PATH = "assets/templates/github-stats-template.svg";
const LANGS_TEMPLATE_PATH = "assets/templates/github-langs-template.svg";

function setText(svg, id, value) {
  const re = new RegExp(`(<text id="${id}"[^>]*>)([\\s\\S]*?)(</text>)`);
  if (!re.test(svg)) throw new Error(`Template is missing id="${id}" (<text>)`);
  return svg.replace(re, `$1${escapeXml(value)}$3`);
}

function setAttr(svg, id, attr, value) {
  const re = new RegExp(`(<[a-zA-Z]+ id="${id}"[^>]*?\\s${attr}=")[^"]*(")`);
  if (!re.test(svg)) throw new Error(`Template is missing id="${id}" with attribute "${attr}"`);
  return svg.replace(re, `$1${value}$2`);
}

function writeStatsSvg({ username, totalStars, totalForks, totalCommits, totalPRs, totalIssues, contributedTo, timestamp }) {
  let svg = readFileSync(STATS_TEMPLATE_PATH, "utf8");
  svg = setText(svg, "total-stars", String(totalStars));
  svg = setText(svg, "total-forks", String(totalForks));
  svg = setText(svg, "total-commits", String(totalCommits));
  svg = setText(svg, "total-prs", String(totalPRs));
  svg = setText(svg, "total-issues", String(totalIssues));
  svg = setText(svg, "contributed-to", `${contributedTo} repos`);
  svg = setText(svg, "last-updated", `Last updated: ${timestamp}`);
  writeFileSync("assets/github-stats.svg", svg);
}

function writeLangsSvg({ topLangs, timestamp }) {
  let svg = readFileSync(LANGS_TEMPLATE_PATH, "utf8");

  const MAX_ROWS = 5;
  const BAR_START_X = 22;
  const BAR_WIDTH = 323; // matches the template's bar track (x 22 to 345)
  const ROW_CY_START = 114; // first row's dot/text vertical center, from the template
  const ROW_SPACING = 21.5; // vertical gap between rows, from the template

  const shown = topLangs.slice(0, MAX_ROWS);
  const hidden = topLangs.slice(MAX_ROWS);

  let barX = BAR_START_X;

  for (let slot = 1; slot <= MAX_ROWS; slot++) {
    const lang = shown[slot - 1];
    const hasLang = Boolean(lang);
    const cy = ROW_CY_START + (slot - 1) * ROW_SPACING;
    const color = hasLang ? lang.color : "none"; // "none" hides the dot for an unused slot
    const width = hasLang ? (lang.percent / 100) * BAR_WIDTH : 0;

    svg = setText(svg, `lang${slot}-name`, hasLang ? lang.name : "");
    svg = setText(svg, `lang${slot}-pct`, hasLang ? `${lang.percent.toFixed(1)}%` : "");
    svg = setAttr(svg, `lang${slot}-name`, "y", (cy + 4).toFixed(1));
    svg = setAttr(svg, `lang${slot}-pct`, "y", (cy + 6).toFixed(1));
    svg = setAttr(svg, `lang${slot}-dot`, "cy", cy.toFixed(1));
    svg = setAttr(svg, `lang${slot}-dot`, "fill", color);
    svg = setAttr(svg, `lang${slot}-bar`, "fill", hasLang ? lang.color : "none");
    svg = setAttr(svg, `lang${slot}-bar`, "x", barX.toFixed(2));
    svg = setAttr(svg, `lang${slot}-bar`, "width", width.toFixed(2));

    barX += width;
  }

  // Vertical position right after the last visible row
  const lastRowCy = ROW_CY_START + (shown.length - 1) * ROW_SPACING;
  let cursorY = lastRowCy;

  if (hidden.length > 0) {
    const names = hidden.map((l) => l.name).join(", ");
    cursorY += ROW_SPACING;
    svg = setText(svg, "more-langs", `+${hidden.length} outras: ${names}`);
    svg = setAttr(svg, "more-langs", "y", (cursorY + 4).toFixed(1));
  } else {
    svg = setText(svg, "more-langs", "");
  }

  const footerY = cursorY + 30;
  const cardHeight = Math.round(footerY + 14);

  svg = setText(svg, "last-updated", `Last updated: ${timestamp}`);
  svg = setAttr(svg, "last-updated", "y", footerY.toFixed(1));

  svg = setAttr(svg, "root-svg", "height", String(cardHeight));
  svg = setAttr(svg, "root-svg", "viewBox", `0 0 367 ${cardHeight}`);
  svg = setAttr(svg, "card-bg", "height", String(cardHeight - 1));
  svg = setAttr(svg, "clip-rect", "height", String(cardHeight));

  writeFileSync("assets/github-langs.svg", svg);
}

async function main() {
  console.log(`Fetching stats for ${USERNAME}...`);

  const mainData = await graphql(MAIN_QUERY, { login: USERNAME });
  const user = mainData.user;
  if (!user) {
    throw new Error(`User "${USERNAME}" not found (check GH_USERNAME).`);
  }

  const totalStars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazers.totalCount, 0);
  const totalForks = user.repositories.nodes.reduce((sum, r) => sum + r.forkCount, 0);
  const totalPRs = user.pullRequests.totalCount;
  const totalIssues = user.issues.totalCount;
  const contributedTo = user.repositoriesContributedTo.totalCount;

  const years = user.contributionsCollection.contributionYears;
  const yearsData = await graphql(yearsQuery(years), { login: USERNAME });

  const publicCommits = years.reduce(
    (sum, y) => sum + (yearsData.user[`year${y}`]?.totalCommitContributions || 0),
    0
  );

  // After enabling "Include private contributions on my profile" in the
  // account's settings, it bundles private commits + issues
  // + PRs + reviews into one number - GitHub's API doesn't
  // split it out by type - it as an approximation.
  const restrictedCount = years.reduce(
    (sum, y) => sum + (yearsData.user[`year${y}`]?.restrictedContributionsCount || 0),
    0
  );

  const totalCommits = publicCommits + restrictedCount;

  const langTotals = {};
  for (const repo of user.repositories.nodes) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      langTotals[name] = (langTotals[name] || 0) + edge.size;
      if (!LANG_COLORS[name]) LANG_COLORS[name] = edge.node.color || "#58a6ff";
    }
  }

  const totalBytes = Object.values(langTotals).reduce((a, b) => a + b, 0) || 1;
  const topLangs = Object.entries(langTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12) // keep a reasonable pool; the card shows up to 5 rows + a "+N outras" summary
    .map(([name, bytes]) => ({
      name,
      percent: (bytes / totalBytes) * 100,
      color: LANG_COLORS[name] || "#58a6ff",
    }));

  console.log("Summary:", { totalStars, totalForks, totalCommits, totalPRs, totalIssues, contributedTo });
  console.log("Top languages:", topLangs.map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(", "));

  const timestamp =
    new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) + " BRT";

  mkdirSync("assets", { recursive: true });
  writeStatsSvg({ username: USERNAME, totalStars, totalForks, totalCommits, totalPRs, totalIssues, contributedTo, timestamp });
  writeLangsSvg({ topLangs, timestamp });

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

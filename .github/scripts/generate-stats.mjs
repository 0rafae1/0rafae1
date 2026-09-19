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

import { writeFileSync, mkdirSync } from "node:fs";

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
          stargazerCount
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

function writeStatsSvg({ username, totalStars, totalForks, totalCommits, totalPRs, totalIssues, contributedTo, timestamp }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="200" viewBox="0 0 500 200">
  <defs>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#21262d;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0d1117;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="500" height="200" rx="10" fill="url(#cardGrad)" stroke="#ffffff" stroke-width="1"/>
  <text x="25" y="40" style="fill:#58a6ff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:26px; font-weight:600;">${escapeXml(username)}'s GitHub Stats</text>
  <g style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <g transform="translate(25, 65)">
      <text y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">⭐ Total Stars Earned:</text>
      <text x="200" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${totalStars}</text>
      <text x="280" y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">🔗 Total Forks:</text>
      <text x="410" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${totalForks}</text>
    </g>
    <g transform="translate(25, 90)">
      <text y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">📝 Total Commits:</text>
      <text x="200" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${totalCommits}</text>
      <text x="280" y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">🔀 Total PRs:</text>
      <text x="410" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${totalPRs}</text>
    </g>
    <g transform="translate(25, 115)">
      <text y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">🐛 Total Issues:</text>
      <text x="200" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${totalIssues}</text>
      <text x="280" y="0" style="fill:#38BDAE; font-size:16px; font-weight:bold;">🚀 Contributed to:</text>
      <text x="445" y="0" style="fill:#f0f6fc; font-size:14px; font-weight:600;">${contributedTo} repos</text>
    </g>
  </g>
  <text x="25" y="185" style="fill:#484f58; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:10px;">Last updated: ${timestamp}</text>
</svg>
`;
  writeFileSync("assets/github-stats.svg", svg);
}

function writeLangsSvg({ topLangs, timestamp }) {
  const barWidth = 450;
  let currentX = 0;
  const bars = topLangs
    .map((l) => {
      const w = (l.percent / 100) * barWidth;
      const rect = `<rect x="${currentX.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="12" fill="${l.color}" rx="6"/>`;
      currentX += w;
      return rect;
    })
    .join("\n    ");

  const rows = topLangs
    .map(
      (l, i) => `
  <g transform="translate(25, ${180 + i * 35})">
    <circle cx="8" cy="0" r="6" fill="${l.color}"/>
    <text x="25" y="5" style="fill:#38bdae; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:24px; font-weight:500;">${escapeXml(l.name)}</text>
    <text x="400" y="5" style="fill:#7d8590; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:20px;">${l.percent.toFixed(1)}%</text>
  </g>`
    )
    .join("\n");

  const noData = topLangs.length
    ? ""
    : `<text x="25" y="150" style="fill:#7d8590; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:18px;">No language data available</text>`;

  const height = 320 + Math.max(0, topLangs.length - 5) * 35;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="${height}" viewBox="0 0 500 ${height}">
  <defs>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#21262d;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0d1117;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="500" height="${height}" rx="10" fill="url(#cardGrad)" stroke="#ffffff" stroke-width="1"/>
  <text x="25" y="50" style="fill:#58a6ff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:36px; font-weight:600;">Most Used Languages</text>
  <g transform="translate(25, 120)">
    ${bars}
  </g>
  ${rows}
  ${noData}
  <text x="25" y="${height - 15}" style="fill:#484f58; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:10px;">Last updated: ${timestamp}</text>
</svg>
`;
  writeFileSync("assets/github-langs.svg", svg);
}

async function main() {
  console.log(`Fetching stats for ${USERNAME}...`);

  const mainData = await graphql(MAIN_QUERY, { login: USERNAME });
  const user = mainData.user;
  if (!user) {
    throw new Error(`User "${USERNAME}" not found (check GH_USERNAME).`);
  }

  const totalStars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);
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
    .slice(0, 6)
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

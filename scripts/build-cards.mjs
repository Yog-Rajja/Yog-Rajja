// Builds every image on the profile README from live GitHub data, so nothing depends on a
// third-party card service. Run: GH_TOKEN=... node scripts/build-cards.mjs
//
// The token decides what the cards can see. The Actions GITHUB_TOKEN sees public repos only;
// a personal token (PROFILE_TOKEN secret) adds private repos to the language breakdown.

import { mkdir, writeFile } from "node:fs/promises"

const LOGIN = process.env.PROFILE_LOGIN ?? "Yog-Rajja"
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const OUT = new URL("../assets/", import.meta.url)
if (!TOKEN) throw new Error("Set GH_TOKEN to a GitHub token")

const THEMES = {
  dark: {
    bg: "#0d1117", border: "#30363d", ink: "#e6edf3", muted: "#8b949e", faint: "#6e7681",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
  },
  light: {
    bg: "#ffffff", border: "#d0d7de", ink: "#1f2328", muted: "#59636e", faint: "#818b98",
    levels: ["#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329"],
  },
}
// Pinned so a new Simple Icons release cannot silently redraw the stack strip.
const SIMPLE_ICONS = "16.33.0"
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

// ---------------------------------------------------------------- data

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}

const data = await gql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } }
      }
      pullRequests(states: MERGED) { totalCount }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        totalCount
        nodes { name isPrivate languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } }
      }
    }
  }`,
  { login: LOGIN },
)

const user = data.user
const cc = user.contributionsCollection
const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays)

let longest = 0
let run = 0
for (const d of days) {
  run = d.contributionCount > 0 ? run + 1 : 0
  longest = Math.max(longest, run)
}
// A day with nothing yet today should not break the current streak.
let current = 0
for (let i = days.length - 1; i >= 0; i--) {
  if (days[i].contributionCount > 0) current++
  else if (i !== days.length - 1) break
}

// Copies of a repo (same language byte counts) would count twice, so keep the first of each.
const seen = new Set()
const langs = new Map()
for (const repo of user.repositories.nodes) {
  const signature = repo.languages.edges.map((e) => `${e.node.name}:${e.size}`).join("|")
  if (!signature || seen.has(signature)) continue
  seen.add(signature)
  for (const { size, node } of repo.languages.edges) {
    const prev = langs.get(node.name) ?? { size: 0, color: node.color ?? "#8b949e" }
    langs.set(node.name, { size: prev.size + size, color: prev.color })
  }
}
const totalBytes = [...langs.values()].reduce((s, l) => s + l.size, 0)
const topLangs = [...langs.entries()]
  .map(([name, l]) => ({ name, color: l.color, pct: (l.size / totalBytes) * 100 }))
  .sort((a, b) => b.pct - a.pct)
const shown = topLangs.slice(0, 6)
const otherPct = topLangs.slice(6).reduce((s, l) => s + l.pct, 0)
if (otherPct >= 0.5) shown.push({ name: "Other", color: "#8b949e", pct: otherPct })

const stats = {
  contributions: cc.contributionCalendar.totalContributions,
  commits: cc.totalCommitContributions + cc.restrictedContributionsCount,
  merged: user.pullRequests.totalCount,
  repos: user.repositories.totalCount,
  longest,
  current,
}

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const fmt = (n) => n.toLocaleString("en-IN")

// Deterministic noise, so the banner does not churn a new commit every day for no reason.
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const svg = (w, h, title, body, css = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t">
<title id="t">${esc(title)}</title>
${css ? `<style>${css}</style>` : ""}
${body}
</svg>
`

const frame = (w, h, t) =>
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>`

// ---------------------------------------------------------------- hero: the name, in contribution cells

const FONT = {
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
}

function hero(t) {
  // Each font pixel is a 2x2 block of cells, so the name reads as a solid wordmark while the
  // grid underneath stays fine enough to look like a real contribution graph.
  const W = 1280, H = 340, P = 10, C = 8, R = 1.6, S = 2
  const cols = Math.floor(W / P), rows = Math.floor(H / P)
  const ox = (W - cols * P) / 2 + (P - C) / 2, oy = (H - rows * P) / 2 + (P - C) / 2
  const at = (c, r) => [ox + c * P, oy + r * P]

  const cells = new Map() // "c,r" -> { level, cls, delay }
  const put = (c, r, v) => cells.set(`${c},${r}`, v)

  const TOP = 3, LEFT = 4
  let col = LEFT
  const rand = rng(7)
  for (const ch of "YOG RAJJA") {
    const g = FONT[ch]
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < g[r].length; c++)
        if (g[r][c] === "1")
          for (let dy = 0; dy < S; dy++)
            for (let dx = 0; dx < S; dx++) {
              const cc2 = col + c * S + dx
              put(cc2, TOP + r * S + dy, { level: rand() < 0.18 ? 3 : 4, cls: "n", delay: cc2 * 0.014 })
            }
    col += (g[0].length + 1) * S
  }
  const nameEnd = col - S

  // Sparse background activity, kept clear of the name and of the text block beneath it.
  const noise = rng(2912)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (cells.has(`${c},${r}`)) continue
      const nearName = r >= TOP - 1 && r <= TOP + 7 * S && c >= LEFT - 1 && c <= nameEnd + 1
      const inText = r >= TOP + 7 * S + 1 && r <= 30 && c >= LEFT - 1 && c <= 76
      const v = noise()
      const level = !inText && !nearName && v < 0.075 ? (v < 0.006 ? 3 : v < 0.02 ? 2 : 1) : 0
      put(c, r, { level, cls: level ? "b" : "", delay: (c + r) * 0.03 })
    }

  const rects = [...cells.entries()]
    .map(([k, v]) => {
      const [c, r] = k.split(",").map(Number)
      const [x, y] = at(c, r)
      const style = v.cls ? ` class="${v.cls}" style="animation-delay:${v.delay.toFixed(2)}s"` : ""
      return `<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="${R}" fill="${t.levels[v.level]}"${style}/>`
    })
    .join("")

  const [tx, titleY] = at(LEFT, 21)
  const line2 = "Building profit and growth software for Indian brands."
  const fs2 = 20, cw = fs2 * 0.6, typed = line2.length
  const typeY = at(0, 24)[1] + 6
  const linksY = at(0, 27)[1] + 8

  const css = `
.n{animation:pop .45s cubic-bezier(.2,.8,.2,1) both;transform-box:fill-box;transform-origin:center}
.b{animation:wave 9s ease-in-out infinite}
@keyframes pop{0%{opacity:0;transform:scale(.2)}100%{opacity:1;transform:scale(1)}}
@keyframes wave{0%,86%,100%{opacity:1}92%{opacity:.2}}
#type{animation:type 2.6s steps(${typed}) 1.7s both}
#caret{animation:caret 2.6s steps(${typed}) 1.7s both,blink 1s step-end 4.3s infinite}
@keyframes type{from{width:0}to{width:${typed * cw}px}}
@keyframes caret{from{transform:translateX(0)}to{transform:translateX(${typed * cw + 4}px)}}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}#type{width:${typed * cw}px}#caret{transform:translateX(${typed * cw + 4}px)}}`

  const body = `${frame(W, H, t)}
<clipPath id="card"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="11"/></clipPath>
<clipPath id="tc"><rect id="type" x="${tx}" y="${typeY - fs2 - 2}" height="${fs2 + 10}" width="0"/></clipPath>
<g clip-path="url(#card)">${rects}</g>
<text x="${tx}" y="${titleY + 4}" font-family="${SANS}" font-size="30" font-weight="600" fill="${t.ink}">Founder, Suprfree</text>
<text x="${tx}" y="${typeY}" font-family="${MONO}" font-size="${fs2}" fill="${t.muted}" clip-path="url(#tc)" textLength="${typed * cw}" lengthAdjust="spacingAndGlyphs">${esc(line2)}</text>
<rect id="caret" x="${tx}" y="${typeY - fs2 + 2}" width="10" height="${fs2 + 2}" fill="${t.levels[4]}"/>
<text x="${tx}" y="${linksY}" font-family="${MONO}" font-size="14" fill="${t.faint}">Suprone  ·  Suprnow  ·  Cocomo  ·  suprfree.com</text>`

  return svg(W, H, "Yog Rajja, founder of Suprfree", body, css)
}

// ---------------------------------------------------------------- stats: numbers and languages

function statsCard(t) {
  const W = 1280, H = 250
  const metrics = [
    [fmt(stats.contributions), "contributions, last 12 months"],
    [fmt(stats.commits), "commits, last 12 months"],
    [fmt(stats.merged), "pull requests merged"],
    [fmt(stats.repos), "repositories built"],
  ]
  const mx = 40, mw = 150
  const nums = metrics
    .map(([v, l], i) => {
      const x = mx + (i % 2) * (mw + 60), y = 96 + Math.floor(i / 2) * 92
      return `<text x="${x}" y="${y}" font-family="${SANS}" font-size="40" font-weight="600" fill="${t.ink}">${esc(v)}</text>
<text x="${x}" y="${y + 24}" font-family="${SANS}" font-size="14" fill="${t.muted}">${esc(l)}</text>`
    })
    .join("\n")

  const lx = 520, lw = W - lx - 40, by = 84
  let x = lx
  const bar = shown
    .map((l) => {
      const w = (l.pct / 100) * lw
      const r = `<rect x="${x.toFixed(1)}" y="${by}" width="${Math.max(w - 2, 1).toFixed(1)}" height="12" fill="${l.color}"/>`
      x += w
      return r
    })
    .join("")
  const legend = shown
    .map((l, i) => {
      const cx = lx + (i % 3) * (lw / 3), cy = by + 52 + Math.floor(i / 3) * 34
      return `<circle cx="${cx + 6}" cy="${cy - 5}" r="6" fill="${l.color}"/>
<text x="${cx + 20}" y="${cy}" font-family="${SANS}" font-size="15" fill="${t.ink}">${esc(l.name)} <tspan fill="${t.muted}">${l.pct.toFixed(1)}%</tspan></text>`
    })
    .join("\n")

  const body = `${frame(W, H, t)}
<text x="${mx}" y="44" font-family="${MONO}" font-size="13" fill="${t.faint}" letter-spacing="1">ACTIVITY</text>
<line x1="480" y1="32" x2="480" y2="${H - 32}" stroke="${t.border}"/>
${nums}
<text x="${lx}" y="44" font-family="${MONO}" font-size="13" fill="${t.faint}" letter-spacing="1">LANGUAGES, BY CODE ACROSS ${seen.size} REPOSITORIES</text>
<clipPath id="bar"><rect x="${lx}" y="${by}" width="${lw}" height="12" rx="6"/></clipPath>
<g clip-path="url(#bar)">${bar}</g>
${legend}
<text x="${W - 40}" y="${H - 22}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${t.faint}">updated ${new Date().toISOString().slice(0, 10)}</text>`
  return svg(W, H, "GitHub activity and languages", body)
}

// ---------------------------------------------------------------- stack: one ink colour, no logo soup

const STACK = [
  ["nextdotjs", "Next.js"], ["react", "React"], ["typescript", "TypeScript"], ["nodedotjs", "Node.js"],
  ["tailwindcss", "Tailwind"], ["threedotjs", "three.js"], ["postgresql", "Postgres"], ["neon", "Neon"],
  ["python", "Python"], ["docker", "Docker"], ["vercel", "Vercel"], ["render", "Render"],
  ["shopify", "Shopify"], ["meta", "Meta Ads"], ["whatsapp", "WhatsApp"],
]

async function stackCard(t, icons) {
  const W = 1280, H = 132, n = STACK.length, pitch = (W - 48) / n
  const tiles = STACK.map(([slug, label], i) => {
    const cx = 24 + pitch * i + pitch / 2
    return `<g transform="translate(${(cx - 16).toFixed(1)} 30) scale(1.3333)" fill="${t.ink}">${icons[slug]}</g>
<text x="${cx.toFixed(1)}" y="100" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${t.muted}">${esc(label)}</text>`
  }).join("\n")
  return svg(W, H, "Tech stack", `${frame(W, H, t)}\n${tiles}`)
}

async function loadIcons() {
  const icons = {}
  for (const [slug] of STACK) {
    const res = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS}/icons/${slug}.svg`)
    const text = await res.text()
    const d = text.match(/ d="([^"]+)"/)?.[1]
    if (!d) throw new Error(`No path for ${slug}`)
    icons[slug] = `<path d="${d}"/>`
  }
  return icons
}

// ---------------------------------------------------------------- write

await mkdir(OUT, { recursive: true })
const icons = await loadIcons()
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(new URL(`hero-${name}.svg`, OUT), hero(t))
  await writeFile(new URL(`stats-${name}.svg`, OUT), statsCard(t))
  await writeFile(new URL(`stack-${name}.svg`, OUT), await stackCard(t, icons))
}
console.log(JSON.stringify({ ...stats, languages: shown.map((l) => `${l.name} ${l.pct.toFixed(1)}%`) }))

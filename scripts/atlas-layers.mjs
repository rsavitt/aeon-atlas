#!/usr/bin/env node
/**
 * atlas-layers — render the seven-layer categorical Atlas page.
 *
 * Reads:
 *   data/atlas-layers.json   — hand-curated layer assignments + per-layer copy
 *   atlas.json               — fork graph, operators, ecosystemProjects, skillPacks
 *   skill-packs.json         — installable pack registry (source of truth for Layer 3)
 *
 * Writes:
 *   quartz/content/atlas-layers.md   — the rendered seven-layer page
 *
 * Bulk layers (fleet, skill-packs) auto-fill from the source data. Hand entries
 * take precedence and add prose. Anything in atlas.json that doesn't end up in a
 * layer surfaces at the bottom as an "Unclassified candidates" section — the
 * curator promotes them by editing data/atlas-layers.json and re-running.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const config = read('data/atlas-layers.json');
const atlas = read('atlas.json');
const packs = read('skill-packs.json');

const FLEET_LIMIT = 30;
const FLEET_LOOKBACK_DAYS = 30;
const now = Date.parse(atlas.generatedAt) || Date.now();
const cutoff = now - FLEET_LOOKBACK_DAYS * 24 * 3600 * 1000;

// Index ecosystem projects + operators for cross-reference.
const ecosystemByName = new Map(
  (atlas.ecosystemProjects || []).map(p => [p.name.toLowerCase(), p])
);
const packsByRepo = new Map(
  (packs.packs || []).map(p => [p.repo, p])
);

// Track which entities have been placed into any layer so we can compute unclassified.
const placed = {
  forks: new Set(),
  packs: new Set(),
  ecosystem: new Set(),
};

const markPlaced = (entry) => {
  if (entry.kind === 'fork' && entry.ref) placed.forks.add(entry.ref);
  if (entry.kind === 'pack' && entry.ref) placed.packs.add(entry.ref);
  if (entry.kind === 'ecosystem' && entry.ref) {
    placed.ecosystem.add(entry.ref.toLowerCase());
  }
};

// Resolve auto block — returns list of synthesized entries to splice in.
function resolveAuto(layer) {
  if (!layer.auto) return [];
  const { source, select, limit } = layer.auto;

  if (source === 'atlas.json' && select === 'active-forks') {
    const forks = (atlas.nodes || [])
      .filter(n => !n.isRoot && !n.archived)
      .map(n => {
        const last = (n.recentCommits || [])[0];
        return { ...n, lastPushTs: last ? Date.parse(last) : 0 };
      })
      .filter(n => n.lastPushTs >= cutoff)
      .sort((a, b) => b.lastPushTs - a.lastPushTs)
      .slice(0, limit ?? FLEET_LIMIT);
    return forks.map(n => ({
      kind: 'fork',
      ref: n.id,
      url: `https://github.com/${n.id}`,
      auto: true,
      meta: {
        stars: n.stars,
        skills: n.skillCount,
        lastPush: new Date(n.lastPushTs).toISOString().slice(0, 10),
      },
    }));
  }

  if (source === 'skill-packs.json' && select === 'packs') {
    return (packs.packs || []).map(p => ({
      kind: 'pack',
      ref: p.repo,
      title: p.name,
      url: p.homepage || `https://github.com/${p.repo}`,
      note: p.description,
      auto: true,
      meta: {
        author: p.author,
        category: p.category,
        trust: p.trust_level,
        skills: (p.skills || []).length,
      },
    }));
  }

  return [];
}

function renderEntry(e) {
  if (e.kind === 'fork') {
    const title = e.title || `\`${e.ref}\``;
    const link = e.url ? `[${title}](${e.url})` : title;
    const meta = e.meta
      ? ` — ${e.meta.skills} skills · ★${e.meta.stars} · last push ${e.meta.lastPush}`
      : '';
    const note = e.note ? `. ${e.note}` : '';
    return `- ${link}${meta}${note}`;
  }
  if (e.kind === 'pack') {
    const title = e.title || `\`${e.ref}\``;
    const link = e.url ? `[${title}](${e.url})` : title;
    const meta = e.meta
      ? ` — ${e.meta.author} · ${e.meta.category} · ${e.meta.trust} · ${e.meta.skills} skills`
      : '';
    const note = e.note ? `. ${e.note}` : '';
    return `- ${link}${meta}${note}`;
  }
  if (e.kind === 'ecosystem') {
    const title = e.title || e.ref;
    const link = e.url ? `[${title}](${e.url})` : title;
    return `- ${link}${e.note ? ` — ${e.note}` : ''}`;
  }
  if (e.kind === 'skill') {
    const title = e.title || `\`${e.ref}\``;
    const link = e.url ? `[${title}](${e.url})` : title;
    return `- ${link}${e.note ? ` — ${e.note}` : ''}`;
  }
  if (e.kind === 'artifact' || e.kind === 'convention') {
    const link = e.url ? `[${e.title}](${e.url})` : e.title;
    return `- ${link}${e.note ? ` — ${e.note}` : ''}`;
  }
  return `- ${e.title || JSON.stringify(e)}`;
}

function renderLayer(layer) {
  const handEntries = layer.entries || [];
  const autoEntries = resolveAuto(layer);

  // De-dupe: hand entries win over auto on same ref.
  const handRefs = new Set(handEntries.map(e => e.ref).filter(Boolean));
  const merged = [
    ...handEntries,
    ...autoEntries.filter(e => !handRefs.has(e.ref)),
  ];

  merged.forEach(markPlaced);

  const lines = [`## ${layer.title}`, '', layer.blurb, ''];
  if (merged.length === 0) {
    lines.push('*No entries yet.*', '');
  } else {
    lines.push(...merged.map(renderEntry), '');
  }
  return lines.join('\n');
}

function unclassifiedSection() {
  const orphanForks = (atlas.nodes || [])
    .filter(n => !n.isRoot && !placed.forks.has(n.id))
    .filter(n => {
      const last = (n.recentCommits || [])[0];
      return last && Date.parse(last) >= cutoff;
    });
  const orphanPacks = (packs.packs || []).filter(p => !placed.packs.has(p.repo));
  const orphanEcosystem = (atlas.ecosystemProjects || []).filter(
    p => !placed.ecosystem.has(p.name.toLowerCase())
  );

  if (
    orphanForks.length === 0 &&
    orphanPacks.length === 0 &&
    orphanEcosystem.length === 0
  ) {
    return '';
  }

  const lines = [
    '## Unclassified candidates',
    '',
    'Entities present in the underlying data that no layer has claimed yet. Promote them by editing `data/atlas-layers.json` and re-running `scripts/atlas-layers.mjs`.',
    '',
  ];

  if (orphanEcosystem.length) {
    lines.push('**Ecosystem projects:**', '');
    for (const p of orphanEcosystem) {
      const url = (p.links || [])[0]?.url || '';
      lines.push(`- ${url ? `[${p.name}](${url})` : p.name}`);
    }
    lines.push('');
  }
  if (orphanPacks.length) {
    lines.push('**Skill packs (unexpected — these should auto-fill Layer 3):**', '');
    for (const p of orphanPacks) lines.push(`- \`${p.repo}\` — ${p.name}`);
    lines.push('');
  }
  if (orphanForks.length) {
    const overflow = orphanForks.length > FLEET_LIMIT;
    const sample = orphanForks
      .slice(0, FLEET_LIMIT)
      .map(n => `\`${n.id}\``)
      .join(', ');
    lines.push(
      `**Active forks beyond the Layer 2 cutoff (top ${FLEET_LIMIT}${overflow ? ' of ' + orphanForks.length : ''}):**`,
      '',
      sample,
      ''
    );
  }
  return lines.join('\n');
}

function renderBlankSpaces() {
  if (!config.blank_spaces || !config.blank_spaces.length) return '';
  return [
    '## The blank spaces',
    '',
    "Categories Hermes Atlas has and Aeon doesn't — yet. Each one is a slot waiting for a single actor's contribution.",
    '',
    ...config.blank_spaces.map(b => `- **${b.title}** — ${b.note}`),
    '',
  ].join('\n');
}

const today = new Date(now).toISOString().slice(0, 10);

const sections = [
  '---',
  `title: "${config.headline}"`,
  `tags: [atlas, ecosystem, meta]`,
  '---',
  '',
  `# ${config.headline}`,
  '',
  `> Auto-rendered by \`scripts/atlas-layers.mjs\` from \`data/atlas-layers.json\` + \`atlas.json\` + \`skill-packs.json\` on ${today}.`,
  '',
  config.subhead,
  '',
  ...config.layers.map(renderLayer),
  renderBlankSpaces(),
  unclassifiedSection(),
  '## How this page is built',
  '',
  'Hand-curated layer assignments live in [`data/atlas-layers.json`](https://github.com/aaronjmars/aeon/blob/main/data/atlas-layers.json). Bulk layers (the fleet, the pack registry) auto-fill from `atlas.json` and `skill-packs.json` respectively. Anything in those feeds that no layer has claimed surfaces under *Unclassified candidates* above — promote an entry by adding it to the right layer in the curation file and re-running.',
  '',
].filter(Boolean);

const out = sections.join('\n');
const outPath = join(ROOT, 'quartz/content/atlas-layers.md');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);

const counts = {
  layers: config.layers.length,
  hand: config.layers.reduce((s, l) => s + (l.entries?.length || 0), 0),
  forksPlaced: placed.forks.size,
  packsPlaced: placed.packs.size,
  ecosystemPlaced: placed.ecosystem.size,
};
console.log(
  `atlas-layers: ${counts.layers} layers · ${counts.hand} hand entries · ${counts.forksPlaced} forks · ${counts.packsPlaced} packs · ${counts.ecosystemPlaced} ecosystem → ${outPath.replace(ROOT + '/', '')}`
);

// Server-side validation of LaunchPad Studio scan summaries (untrusted input) and change detection between scans.
import { sha256 } from './security.ts';

const FEATURES = ['daily', 'streak', 'events', 'limited', 'quests', 'offline', 'trading', 'parties', 'guilds', 'leaderboards', 'invites', 'pvp', 'tutorial', 'rebirth', 'saves', 'gamepass'];
const str = (v: unknown, n: number) => typeof v === 'string' ? v.slice(0, n) : '';
const nn = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const arr = (v: unknown, n: number) => Array.isArray(v) ? v.slice(0, n) : [];

export function parseScan(d: any) {
  if (!d || d.launchpadScan !== 1 || !d.place || typeof d.place.name !== 'string') throw new Error('Not a LaunchPad Studio scan');
  const f = d.features && typeof d.features === 'object' ? d.features : {}, c = d.counts && typeof d.counts === 'object' ? d.counts : {};
  const universeId = nn(d.place.universeId);
  if (!universeId || !Number.isSafeInteger(universeId) || universeId <= 0) throw new Error('This place isn\'t published, so it has no experience ID');
  return {
    launchpadScan: 1, plugin: str(d.plugin, 20), scannedAt: nn(d.scannedAt) ?? Math.floor(Date.now() / 1000), codeRead: d.codeRead === true,
    place: { placeId: nn(d.place.placeId) ?? 0, universeId, name: str(d.place.name, 80).trim() || 'Untitled place', description: str(d.place.description, 4000), creatorName: str(d.place.creatorName, 80), listingSource: d.place.listingSource ? 'Retrieved from Roblox' : undefined },
    counts: Object.fromEntries(['instances', 'scripts', 'localScripts', 'modules', 'screenGuis', 'spawns', 'prompts', 'codeRead'].map(k => [k, nn(c[k]) ?? 0])),
    ui: { texts: arr(d.ui?.texts, 80).map(t => str(t, 120)).filter(Boolean), hasSkip: !!d.ui?.hasSkip },
    prompts: arr(d.prompts, 40).filter(p => p && typeof p === 'object').map((p: any) => ({ action: str(p.action, 60), object: str(p.object, 60), path: str(p.path, 200) })),
    features: Object.fromEntries(FEATURES.map(k => [k, arr(f[k], 5).map(x => str(x, 200)).filter(Boolean)])),
    economy: arr(d.economy, 60).filter((e: any) => e && nn(e.cost) != null && e.cost > 0).map((e: any) => ({ name: str(e.name, 60) || 'Unnamed', cost: e.cost, income: nn(e.income), incomeKey: str(e.incomeKey, 40), reward: nn(e.reward), rewardKey: str(e.rewardKey, 40), path: str(e.path, 200), source: e.source === 'Analyzed from script logic' ? e.source : 'Read from Studio DataModel' })),
  };
}

const SECTIONS = { listing: (s: any) => s.place, structure: (s: any) => [s.counts.instances, s.counts.scripts, s.counts.modules, s.counts.screenGuis, s.counts.spawns], ui: (s: any) => [s.ui, s.prompts], systems: (s: any) => s.features, economy: (s: any) => s.economy };
export function sectionHashes(scan: any) { return Object.fromEntries(Object.entries(SECTIONS).map(([k, f]) => [k, sha256(JSON.stringify(f(scan)))])); }
export function changedSections(prev: Record<string, string> | null, next: Record<string, string>) { return prev ? Object.keys(next).filter(k => prev[k] !== next[k]) : Object.keys(next); }

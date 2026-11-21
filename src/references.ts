// Reference catalog of real Roblox experiences, built from Roblox's public web APIs (no auth, public data only):
// games.roblox.com (name, creator, description, genre, playing, visits, favorites), thumbnails.roblox.com (icon, thumbnails),
// apis.roblox.com/universes (place → universe). Tags (style, mechanics) come from a cheap model looking at the public assets.
import { configured } from './config.ts';
import { db } from './db.ts';
import { generate, io } from './ai.ts';

const get = async (url: string) => {
  for (let i = 0; i < 3; i++) {
    const r = await io.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 429 || r.status >= 500) { await io.sleep(1000 * 2 ** i); continue; } // respect Roblox throttling
    if (!r.ok) throw new Error(`Roblox returned ${r.status} for ${new URL(url).host}`);
    return r.json() as Promise<any>;
  }
  throw new Error('Roblox is rate-limiting requests. Try again later.');
};
export async function universeForPlace(placeId: string) { return String((await get(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)).universeId ?? ''); }

export const STYLES = ['bright cartoon', 'realistic', 'anime', 'low-poly', 'dark/moody', 'pastel', 'neon', 'pixel/voxel'];
export const MECHANICS = ['collecting', 'pets', 'eggs/gacha', 'rebirth', 'tycoon building', 'idle income', 'combat', 'quests', 'obby/parkour', 'trading', 'stealing/raiding', 'fishing', 'farming', 'crafting', 'survival', 'horror', 'roleplay', 'racing', 'pvp', 'leaderboards', 'daily rewards', 'events', 'upgrades', 'exploration', 'puzzle', 'social hangout'];
const TAG_SCHEMA = { name: 'reference_tags', schema: { type: 'object', additionalProperties: false, required: ['game_type', 'styles', 'mechanics', 'audience', 'presentation_notes'], properties: {
  game_type: { type: 'string', enum: ['simulator', 'tycoon', 'obby', 'rpg', 'horror', 'roleplay', 'fighting', 'survival', 'racing', 'puzzle', 'shooter', 'social', 'other'] },
  styles: { type: 'array', maxItems: 3, items: { type: 'string', enum: STYLES } }, mechanics: { type: 'array', maxItems: 8, items: { type: 'string', enum: MECHANICS } },
  audience: { type: 'string', enum: ['younger kids', 'kids and teens', 'teens', 'teens and adults', 'broad'] }, presentation_notes: { type: 'string' } } } };

// Adds or refreshes experiences by universe ID. Returns what was stored. Batches of up to 50 per Roblox call.
export async function refreshReferences(universeIds: string[], o: { tag?: boolean } = {}) {
  const ids = [...new Set(universeIds.filter(x => /^\d{1,20}$/.test(x)))].slice(0, 50); if (!ids.length) return [];
  const [games, icons, thumbs] = await Promise.all([
    get(`https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`),
    get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`),
    get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${ids.join(',')}&countPerUniverse=4&defaults=true&size=768x432&format=Png&isCircular=false`),
  ]);
  const out = [];
  for (const g of games.data ?? []) {
    const ic = (icons.data ?? []).find((x: any) => String(x.targetId) === String(g.id) && x.state === 'Completed')?.imageUrl, icon = /^https:\/\/[\w.-]+\.rbxcdn\.com\//.test(ic ?? '') ? ic : null;
    const th = ((thumbs.data ?? []).find((x: any) => String(x.universeId) === String(g.id))?.thumbnails ?? []).filter((t: any) => t.state === 'Completed' && /^https:\/\/[\w.-]+\.rbxcdn\.com\//.test(t.imageUrl)).map((t: any) => t.imageUrl);
    const stats = { playing: g.playing ?? null, visits: g.visits ?? null, favorites: g.favoritedCount ?? null, updated: g.updated ?? null, fetchedAt: new Date().toISOString() };
    let tags = (await db.one('select tags from reference_games where universe_id = $1', [g.id]))?.tags ?? {};
    if (o.tag !== false && configured.openai() && (th[0] || icon)) {
      try {
        const r = await generate<any>({ task: 'classify_reference', system: 'You tag Roblox experiences for a reference catalog from their public listing and thumbnail. Only use what you can see or read. Pick from the allowed values.',
          parts: [{ type: 'input_text', text: JSON.stringify({ name: g.name, genre: g.genre, description: String(g.description ?? '').slice(0, 1500) }) }, ...(th[0] ? [{ type: 'input_image' as const, image_url: th[0], detail: 'low' as const }] : [])], schema: TAG_SCHEMA, maxOutput: 400 });
        tags = { ...r.data, taggedBy: r.model, taggedAt: new Date().toISOString() };
      } catch { /* keep earlier tags; genre still works for matching */ }
    }
    await db.query(`insert into reference_games (universe_id, root_place_id, name, creator, description, genre, icon_url, thumbnail_urls, stats, tags, refreshed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      on conflict (universe_id) do update set root_place_id = excluded.root_place_id, name = excluded.name, creator = excluded.creator, description = excluded.description, genre = excluded.genre,
        icon_url = excluded.icon_url, thumbnail_urls = excluded.thumbnail_urls, stats = excluded.stats, tags = excluded.tags, refreshed_at = now()`,
      [g.id, g.rootPlaceId ?? null, String(g.name).slice(0, 120), String(g.creator?.name ?? '').slice(0, 80), String(g.description ?? '').slice(0, 4000), g.genre ?? null, icon, JSON.stringify(th), stats, tags]);
    out.push({ universeId: String(g.id), name: g.name });
  }
  return out;
}

// Relevance to one game and one analysis (not a quality score): game type/genre, shared mechanics, style, data available.
const GENRE_MAP: Record<string, string> = { simulator: 'simulator', tycoon: 'tycoon', obby: 'obby', rpg: 'rpg', horror: 'horror', roleplay: 'roleplay', fighting: 'fighting', survival: 'survival', racing: 'racing', puzzle: 'puzzle', shooter: 'shooter' };
export function gameProfile(g: any) {
  const text = `${g.name ?? ''} ${g.description ?? ''} ${g.loop ?? ''}`.toLowerCase();
  const mech = MECHANICS.filter(m => m.split(/[/ ]/).some(w => w.length > 3 && text.includes(w.replace(/s$/, ''))));
  return { type: GENRE_MAP[g.genre] ?? (g.genre || 'other'), mechanics: mech };
}
export function scoreReference(ref: any, prof: { type: string; mechanics: string[] }, focus: string) {
  const t = ref.tags ?? {}, reasons: string[] = []; let s = 0;
  const type = t.game_type ?? (String(ref.genre ?? '').toLowerCase().includes(prof.type) ? prof.type : null);
  if (type && type === prof.type) { s += 0.45; reasons.push(`Same game type (${type})`); }
  const shared = (t.mechanics ?? []).filter((m: string) => prof.mechanics.includes(m));
  if (shared.length) { s += Math.min(0.35, shared.length * 0.12); reasons.push(`Shared mechanics: ${shared.join(', ')}`); }
  if ((focus === 'thumbnail' || focus === 'game-page') && (ref.thumbnail_urls?.length || ref.icon_url)) { s += 0.1; reasons.push('Public thumbnail and icon available'); }
  if (ref.stats?.visits != null) { s += 0.05; reasons.push('Public visit and favorite counts available'); }
  if (ref.refreshed_at && Date.now() - new Date(ref.refreshed_at).getTime() < 30 * 86400e3) s += 0.05;
  return { score: Math.round(Math.min(1, s) * 100) / 100, reasons };
}
export async function relevantReferences(g: any, focus: string, n = 4) {
  const prof = gameProfile(g), rows = (await db.query('select * from reference_games where active order by refreshed_at desc nulls last limit 500')).rows;
  return rows.map(r => ({ ...r, universe_id: String(r.universe_id), ...scoreReference(r, prof, focus) })).filter(r => r.score >= 0.4).sort((a, b) => b.score - a.score).slice(0, n);
}

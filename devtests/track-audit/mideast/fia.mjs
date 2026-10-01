// FIA 2025 event documents (circuit map / pit lane drawing / race director's event notes) of the four Middle-East
// events: cached under cache/fia/ (PDF; text extracted with pdfjs-dist from the scratchpad -> <name>.txt).
import { cachedGet } from './net.mjs';
const B = 'https://www.fia.com/system/files/decision-document/';
export const FIA_DOCS = {
  'bh-2002': ['2025_bahrain_grand_prix_-_event_notes_-_circuit_map_pit_lane_quarantine_zone_and_red_zones.pdf', '2025_bahrain_grand_prix_-_event_notes_-_pit_lane_drawing_v2.pdf'],
  'sa-2021': ['2025_saudi_arabian_grand_prix_-_event_notes_-_circuit_map_pit_lane_and_quarantine_zone.pdf', '2025_saudi_arabian_grand_prix_-_race_directors_event_notes_.pdf'],
  'qa-2004': ['2025_qatar_grand_prix_-_event_notes_-_circuit_map._pit_lane_drawing_emergency_exits_map_ers_battery_containment_area_red_zones_map.pdf', '2025_qatar_grand_prix_-_race_directors_event_notes_.pdf'],
  'ae-2009': ['2025_abu_dhabi_grand_prix_-_event_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_quarantine_zone_and_red_zones.pdf', '2025_abu_dhabi_grand_prix_-_race_directors_event_notes_v2.pdf'],
};
for (const id of Object.keys(FIA_DOCS)) for (const n of FIA_DOCS[id]) { const b = await cachedGet('fia', n, B + n, { binary: true, gapMs: 3000 }); console.log(id, n, b.length); }

// loader for the probes against the pre-fix track.js (reconstructed copy)
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
global.window = global; global.self = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(process.env.TRACKS_DATA || path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(__dirname, '..', 'track-pre.js'));
require(path.join(ROOT, 'js', 'scenery.js'));
module.exports = { F1: window.F1, TRACKS: window.F1_TRACKS, SCENERY: window.F1_SCENERY, THREE: global.THREE, ROOT };

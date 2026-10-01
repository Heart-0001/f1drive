// loader: three + tracks + scenery data + track.js + scenery.js in node (verifier copy)
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
global.window = global; global.self = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
if (!global.THREE.Vector3) { global.THREE = window.THREE; }
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'scenery.js'));
module.exports = { F1: window.F1, TRACKS: window.F1_TRACKS, SCENERY: window.F1_SCENERY, THREE: global.THREE, ROOT };

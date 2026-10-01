// Loads the real game modules into node.
const path = require('path');
const P = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(P + '/lib/three.min.js');
require(P + '/tracks-data.js');
require(P + '/js/track.js');
require(P + '/js/car.js');
module.exports = { F1: global.F1, TRACKS: global.F1_TRACKS, THREE: global.THREE };

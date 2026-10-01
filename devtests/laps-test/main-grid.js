// js/main.js's placeOnGrid(slot) for the node tests, taken from the SOURCE of js/main.js (main.js itself needs a
// browser): the tests place the car exactly as the game does and cannot drift from it.
//   const place = require('./main-grid')(track, car);   place(slot) -> sample index, car.state is on the slot
//   require('./main-grid').CAR_NOSE                       main.js's constant
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'main.js'), 'utf8');

function functionSource(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('js/main.js: function ' + name + ' not found');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('js/main.js: end of function ' + name + ' not found');
}
function constant(name) {
  const m = new RegExp('\\bvar ' + name + ' = (-?[\\d.]+);').exec(src);
  if (!m) throw new Error('js/main.js: constant ' + name + ' not found');
  return Number(m[1]);
}

const CAR_NOSE = constant('CAR_NOSE');
const body = functionSource('placeOnGrid') + '\nreturn placeOnGrid;';

module.exports = function (track, car) { return new Function('track', 'car', 'CAR_NOSE', body)(track, car, CAR_NOSE); };
module.exports.CAR_NOSE = CAR_NOSE;
module.exports.START_BACK = constant('START_BACK');
module.exports.source = body;

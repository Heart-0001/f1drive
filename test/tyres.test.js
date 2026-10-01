// node test/tyres.test.js — tyre model (js/tyres.js): pure logic, fed with synthetic loads and with a real racing lap.
'use strict';
const assert = require('assert');
const Tyres = require('../js/tyres.js');
const { createTyres, wearLoss, nextCompound } = Tyres;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}
const info = s => console.log('       ' + s);

const DT = 1 / 120;                     // car.js physics step
const FL = 0, FR = 1, RL = 2, RR = 3, W = ['FL', 'FR', 'RL', 'RR'];
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const L0 = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 };
const load = o => Object.assign({}, L0, o);
// feed one load for `sec` seconds; each(ty, step) after every step, a truthy result stops early
function run(ty, sec, l, each) {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) { ty.update(DT, l); if (each && each(ty, i)) return i; }
  return n;
}
const copy = s => JSON.parse(JSON.stringify(s));
const maxWear = ty => Math.max(...ty.state.wear);
const argMax = a => a.indexOf(Math.max(...a));
function fresh(c, rate, random) {
  const ty = createTyres({ random: random || seeded(7) });
  if (c) ty.fit(c);
  if (rate !== undefined) ty.setWearRate(rate);
  return ty;
}

// A real racing lap: Albert Park (5.28 km, clockwise), the reference car (js/car.js) on the racing line at full pace,
// driven at 120 Hz by the end-to-end autopilot (devtests/gp-e2e/autopilot.js, analog pedals); the load of every step
// derived from the car's state exactly as car.js computes its limits (devtests/tyres-test/trace.js, which exported
// these key points: [step, speed m/s, lat, brake, drive, ...], linear in between, within 1 m/s / 0.08 of every step).
// Clean racing: no slip, grass or impacts.
const LAP = { id: "au-1953", len: 5275, steps: 11010, time: 91.750, k: [
0,76.8,0.022,0,0.572,149,75.8,0.007,0,0.621,299,74.1,-0.018,0,0.405,300,74,-0.018,0.129,0,386,62.6,-0.036,0.565,0,449,52.9,-0.081,0.639,0,492,46.6,-0.435,0.748,0,521,42.6,-0.56,0.764,0,523,42.4,-0.555,0.648,0,548,39.3,-0.601,0.766,0,555,38.5,-0.578,0.682,0,568,36.9,-0.664,0.813,0,
581,35.3,-0.641,0.742,0,582,35.2,-0.664,0.418,0,589,34.7,-0.638,0.365,0,590,34.7,-0.657,0.182,0,611,34,-0.628,0.096,0,612,33.9,-0.646,0.332,0,617,33.6,-0.625,0.302,0,618,33.5,-0.656,0.469,0,635,32.2,-0.68,0.509,0,639,31.8,-0.661,0.464,0,640,31.8,-0.673,0.181,0,645,31.6,-0.663,0.159,0,
646,31.6,-0.651,0,0.053,655,31.5,-0.628,0,0.093,656,31.6,-0.596,0,0.564,661,31.7,-0.609,0,0.538,662,31.8,-0.578,0,0.927,667,32.1,-0.596,0,0.876,668,32.2,-0.567,0,0.988,725,36.3,-0.388,0,0.987,764,39.1,-0.107,0,0.904,782,40.3,0.096,0,0.983,830,43.6,0.323,0,1,956,51.7,0.65,0,1,
1278,68,-0.043,0,1,1387,72.1,-0.076,0,1,1388,72.1,-0.076,0,0.629,1414,72.1,-0.077,0,0.575,1669,71,-0.066,0,0.589,1791,70.2,-0.085,0,0.415,1792,70.1,-0.087,0.074,0,1840,65,-0.104,0.42,0,1912,54.7,-0.135,0.666,0,1969,46.4,-0.156,0.696,0,1993,43.1,-0.344,0.754,0,1997,42.6,-0.337,0.613,0,
2027,38.9,-0.565,0.74,0,2038,37.8,-0.598,0.464,0,2053,36.5,-0.723,0.524,0,2059,36,-0.702,0.432,0,2060,35.9,-0.748,0.719,0,2073,34.5,-0.734,0.674,0,2080,33.6,-0.787,0.814,0,2087,32.8,-0.695,0.723,0,2088,32.7,-0.745,0.821,0,2103,31,-0.711,0.678,0,2104,30.9,-0.751,0.509,0,2111,30.4,-0.719,0.446,0,
2112,30.3,-0.755,0.123,0,2157,29.2,-0.753,0.062,0,2158,29.1,-0.768,0.423,0,2179,27.6,-0.741,0.472,0,2183,27.3,-0.723,0.428,0,2184,27.3,-0.73,0.263,0,2189,27,-0.717,0.235,0,2190,27,-0.715,0,0.03,2201,27,-0.707,0,0.138,2202,27,-0.693,0,0.517,2207,27.2,-0.704,0,0.492,2208,27.2,-0.69,0,0.883,
2215,27.7,-0.717,0,0.809,2216,27.7,-0.702,0,0.949,2223,28.2,-0.73,0,0.869,2224,28.3,-0.712,0,0.998,2231,28.8,-0.74,0,0.913,2232,28.9,-0.719,0,1,2287,33,-0.746,0,1,2347,37.5,-0.609,0,1,2348,37.5,-0.613,0,0.176,2420,38.2,-0.139,0,0.447,2483,39.7,0.371,0,0.495,2501,40.1,0.526,0,0.453,
2502,40,0.564,0,0.01,2556,37.2,0.748,0.469,0,2569,36.3,0.728,0.309,0,2570,36.2,0.752,0.111,0,2576,36.1,0.762,0.02,0,2589,35.8,0.757,0.004,0,2590,35.8,0.784,0.121,0,2595,35.7,0.767,0.104,0,2596,35.6,0.794,0.43,0,2601,35.2,0.771,0.391,0,2602,35.1,0.797,0.545,0,2615,34,0.762,0.468,0,
2621,33.6,0.763,0.34,0,2622,33.6,0.778,0.021,0,2627,33.5,0.765,0.012,0,2628,33.5,0.772,0,0.247,2637,33.6,0.76,0,0.277,2638,33.6,0.752,0,0.605,2641,33.7,0.753,0,0.59,2642,33.8,0.743,0,0.893,2660,35,0.743,0,1,2771,42.8,0.639,0,1,2843,47.7,0.337,0,1,2844,47.7,0.338,0,0.333,
2891,47.8,0.191,0,0.32,2972,48.9,-0.05,0,0.535,3057,50.3,-0.313,0,0.414,3058,50.3,-0.33,0,0.037,3064,50.1,-0.348,0.031,0,3102,47.8,-0.47,0.375,0,3150,43.1,-0.527,0.614,0,3154,42.6,-0.516,0.477,0,3174,40.6,-0.582,0.604,0,3193,38.6,-0.606,0.568,0,3197,38.2,-0.587,0.521,0,3198,38.2,-0.622,0,0.088,
3203,38.2,-0.61,0,0.094,3204,38.2,-0.634,0,0.769,3213,38.7,-0.636,0,0.747,3214,38.8,-0.636,0,0.891,3219,39.1,-0.631,0,0.843,3228,39.7,-0.595,0,1,3418,52.1,-0.313,0,1,3599,62,-0.119,0,1,3600,62,-0.116,0,0.505,3883,63,0.112,0,0.499,3919,62.9,0.155,0,0.429,3920,62.9,0.16,0,0.01,
3921,62.8,0.159,0,0.01,3967,59,0.094,0.358,0,4042,49.6,-0.589,0.691,0,4063,46.6,-0.661,0.691,0,4068,45.9,-0.69,0.792,0,4087,43.1,-0.746,0.786,0,4089,42.9,-0.734,0.755,0,4090,42.8,-0.763,0.467,0,4093,42.4,-0.751,0.704,0,4095,42.1,-0.739,0.675,0,4096,42.1,-0.762,0.397,0,4100,41.7,-0.743,0.349,0,
4102,41.6,-0.76,0.444,0,4107,41.1,-0.739,0.387,0,4108,41,-0.755,0.51,0,4113,40.5,-0.732,0.464,0,4114,40.4,-0.748,0.678,0,4149,36.1,-0.727,0.673,0,4153,35.6,-0.708,0.616,0,4154,35.6,-0.729,0.206,0,4161,35.3,-0.714,0.171,0,4162,35.3,-0.735,0,0.274,4171,35.3,-0.742,0,0.209,4172,35.3,-0.748,0,0.475,
4177,35.5,-0.746,0,0.454,4178,35.5,-0.747,0,0.769,4186,36,-0.736,0,0.908,4191,36.3,-0.747,0,0.859,4192,36.4,-0.728,0,0.953,4197,36.7,-0.744,0,0.902,4198,36.8,-0.718,0,0.996,4241,39.8,-0.631,0,1,4293,43.5,-0.224,0,1,4346,47.1,0.421,0,1,4390,49.9,0.556,0,1,4445,53.3,0.452,0,1,
4598,61.7,-0.337,0,1,4654,64.4,-0.504,0,1,4809,70.9,-0.626,0,1,4883,73.5,-0.492,0,1,4884,73.5,-0.486,0,0.668,5050,75.8,-0.239,0,0.855,5199,77.5,-0.44,0,0.712,5245,77.2,-0.618,0,0.494,5246,77.1,-0.631,0.24,0,5249,76.7,-0.625,0.224,0,5250,76.5,-0.635,0.515,0,5252,76.1,-0.641,0.532,0,
5273,72,-0.64,0.504,0,5281,70.7,-0.637,0.407,0,5282,70.6,-0.642,0.24,0,5283,70.5,-0.641,0.24,0,5284,70.4,-0.645,0,0.203,5287,70.3,-0.642,0,0.216,5288,70.4,-0.647,0,0.958,5292,70.5,-0.652,0,1,5343,72.4,-0.565,0,1,5448,75.8,0.217,0,1,5494,77.2,0.424,0,1,5691,81.9,0.216,0,1,
5807,84.1,0.261,0,1,5903,85.5,0.449,0,1,5906,85.6,0.451,0,0.902,5946,85.5,0.476,0,0.766,6015,85.2,0.532,0,0.826,6179,85.2,0.301,0,0.828,6269,84.8,0.272,0,0.759,6377,83.2,0.495,0,0.529,6403,82.3,0.574,0,0.352,6404,82.2,0.586,0.006,0,6405,82.2,0.586,0.006,0,6406,82,0.596,0.413,0,
6423,78.8,0.595,0.441,0,6424,78.7,0.6,0.19,0,6427,78.3,0.595,0.176,0,6428,78.3,0.601,0,0.345,6429,78.3,0.601,0,0.345,6430,78.2,0.609,0.131,0,6433,77.9,0.604,0.119,0,6434,77.7,0.611,0.476,0,6459,72.7,0.612,0.627,0,6465,71.5,0.602,0.579,0,6466,71.4,0.608,0.058,0,6471,71,0.614,0.039,0,
6472,71.1,0.624,0,0.819,6491,71.4,0.681,0,0.799,6492,71.2,0.69,0.488,0,6497,70.4,0.681,0.444,0,6498,70.3,0.678,0.053,0,6499,70.3,0.678,0.053,0,6500,70.3,0.677,0,0.82,6549,71.2,0.498,0,0.788,6639,72.4,-0.322,0,0.684,6645,72.4,-0.391,0,0.552,6646,72.2,-0.424,0.38,0,6649,71.8,-0.42,0.361,0,
6650,71.6,-0.451,0.498,0,6665,69.2,-0.538,0.498,0,6666,69.1,-0.558,0,0.005,6667,69.1,-0.557,0,0.005,6669,69,-0.552,0,0.024,6670,69,-0.574,0,1,6685,69.6,-0.669,0,1,6686,69.6,-0.687,0.074,0,6689,69.3,-0.682,0.064,0,6690,69.2,-0.692,0.545,0,6695,68.2,-0.681,0.533,0,6696,68.1,-0.676,0.263,0,
6699,67.8,-0.67,0.247,0,6700,67.8,-0.664,0,0.498,6701,67.8,-0.664,0,0.498,6702,67.8,-0.66,0,0.95,6706,67.9,-0.658,0,1,6882,74.3,-0.187,0,1,7033,78.6,-0.195,0,1,7034,78.7,-0.199,0,0.815,7036,78.7,-0.202,0,0.802,7093,78.6,-0.258,0,0.638,7185,77.7,-0.407,0,0.594,7371,76.1,-0.109,0,0.599,
7485,74.7,-0.047,0,0.421,7486,74.6,-0.046,0.12,0,7560,65.1,-0.023,0.517,0,7624,55.2,-0.01,0.679,0,7757,37.2,-0.119,0.741,0,7789,33.5,-0.221,0.704,0,7797,32.6,-0.248,0.81,0,7811,31,-0.264,0.718,0,7813,30.8,-0.296,0.804,0,7819,30.2,-0.285,0.717,0,7821,29.9,-0.314,0.806,0,7827,29.3,-0.302,0.719,0,
7829,29.1,-0.329,0.811,0,7835,28.5,-0.317,0.723,0,7836,28.3,-0.341,0.819,0,7845,27.4,-0.324,0.703,0,7846,27.3,-0.348,0.804,0,7853,26.6,-0.334,0.717,0,7854,26.5,-0.33,0.824,0,7863,25.6,-0.312,0.707,0,7865,25.4,-0.339,0.82,0,7873,24.6,-0.32,0.704,0,7875,24.4,-0.343,0.824,0,7883,23.6,-0.322,0.707,0,
7884,23.5,-0.341,0.838,0,7893,22.6,-0.318,0.719,0,7894,22.5,-0.332,0.862,0,7903,21.6,-0.307,0.74,0,7905,21.4,-0.315,0.894,0,7915,20.4,-0.285,0.739,0,7916,20.3,-0.29,0.904,0,7917,20.2,-0.288,0.904,0,7927,19.2,-0.249,0.747,0,7928,19.1,-0.257,0.922,0,7940,17.9,-0.223,0.733,0,7943,17.6,-0.225,0.915,0,
7956,16.4,-0.191,0.701,0,7957,16.3,-0.19,0.701,0,7958,16.2,-0.198,0.884,0,7972,15,-0.166,0.678,0,7975,14.7,-0.179,0.849,0,7981,14.2,-0.165,0.758,0,7982,14.1,-0.162,0.532,0,7990,13.7,-0.151,0.455,0,7991,13.6,-0.15,0.455,0,7992,13.6,-0.175,0.636,0,8010,12.5,-0.118,0.45,0,8013,12.3,-0.155,0.602,0,
8031,11.3,-0.128,0.426,0,8032,11.3,-0.168,0.304,0,8077,10.4,-0.231,0.059,0,8078,10.4,-0.205,0,0.302,8085,10.5,-0.21,0,0.277,8086,10.6,-0.182,0,0.701,8101,11.3,-0.212,0,0.561,8102,11.4,-0.182,0,0.956,8119,12.5,-0.224,0,0.736,8120,12.6,-0.191,0,1,8136,13.9,-0.202,0,0.833,8137,13.9,-0.204,0,0.833,
8138,14,-0.184,0,1,8277,25.6,-0.26,0,1,8410,35.9,-0.008,0,1,8591,48.6,-0.007,0,1,8592,48.6,-0.007,0,0.354,8679,50.1,-0.069,0,0.599,8755,52.2,-0.409,0,0.615,8795,53,-0.594,0,0.508,8796,53,-0.62,0,0.267,8799,53,-0.616,0,0.27,8800,52.9,-0.64,0.27,0,8809,52.2,-0.642,0.281,0,
8810,52.1,-0.661,0.15,0,8815,51.8,-0.648,0.127,0,8816,51.8,-0.668,0,0.354,8829,51.7,-0.682,0,0.194,8830,51.6,-0.699,0.393,0,8867,47.5,-0.729,0.541,0,8875,46.6,-0.721,0.45,0,8876,46.5,-0.715,0.16,0,8879,46.4,-0.71,0.149,0,8880,46.4,-0.726,0,0.182,8889,46.3,-0.733,0,0.154,8890,46.3,-0.745,0,0.351,
8893,46.3,-0.742,0,0.349,8894,46.4,-0.751,0,0.859,8899,46.6,-0.752,0,0.819,8900,46.7,-0.761,0,1,8945,49.5,-0.814,0,1,8993,52.5,-0.721,0,1,8994,52.5,-0.706,0,0.404,9000,52.5,-0.686,0,0.353,9209,53.7,-0.078,0,0.463,9243,54,0.007,0,0.417,9244,53.9,0.02,0,0.176,9247,53.9,0.02,0,0.183,
9248,53.9,0.032,0,0.061,9252,53.7,0.044,0.024,0,9322,48.1,0.19,0.517,0,9364,43.4,0.268,0.64,0,9374,42.3,0.286,0.52,0,9394,40.2,0.428,0.629,0,9399,39.7,0.363,0.579,0,9430,36.3,0.646,0.744,0,9437,35.5,0.624,0.661,0,9444,34.7,0.694,0.775,0,9451,33.9,0.666,0.689,0,9458,33.1,0.678,0.823,0,
9465,32.3,0.646,0.732,0,9467,32.1,0.695,0.839,0,9473,31.4,0.661,0.746,0,9475,31.1,0.709,0.859,0,9481,30.4,0.672,0.764,0,9482,30.3,0.72,0.877,0,9489,29.5,0.678,0.78,0,9490,29.3,0.722,0.885,0,9509,27.2,0.654,0.723,0,9510,27.1,0.692,0.539,0,9517,26.6,0.661,0.474,0,9518,26.5,0.654,0.225,0,
9559,25.3,0.678,0.149,0,9560,25.2,0.69,0.422,0,9567,24.8,0.656,0.366,0,9581,23.8,0.68,0.534,0,9587,23.3,0.651,0.463,0,9588,23.3,0.661,0.236,0,9599,23,0.642,0.056,0,9600,23,0.625,0,0.43,9607,23.2,0.642,0,0.399,9608,23.2,0.621,0,0.821,9615,23.6,0.65,0,0.751,9616,23.7,0.626,0,0.937,
9623,24.2,0.658,0,0.855,9624,24.3,0.633,0,1,9632,24.8,0.671,0,0.904,9634,25,0.645,0,1,9731,32.4,0.612,0,0.943,9835,40,0.017,0,1,9837,40.2,-0.02,0,0.977,9838,40.2,-0.052,0,0.235,9842,40.2,-0.052,0,0.234,9843,40.2,-0.052,0,0.234,9844,40.2,-0.084,0,1,9845,40.3,-0.084,0,1,
9846,40.3,-0.085,0,0.261,9878,40.7,-0.287,0,0.448,9937,42.1,-0.624,0,0.529,9941,42.2,-0.62,0,0.508,9942,42.2,-0.654,0.259,0,9947,41.9,-0.639,0.232,0,9948,41.8,-0.666,0,0.118,9953,41.8,-0.655,0,0.125,9954,41.8,-0.682,0,0.422,9977,42,-0.734,0,0.276,9978,42,-0.751,0.403,0,9990,40.9,-0.748,0.465,0,
9999,40.1,-0.742,0.349,0,10000,40.1,-0.752,0.149,0,10005,39.9,-0.729,0.128,0,10006,39.9,-0.746,0,0.039,10027,39.4,-0.778,0.065,0,10033,39.3,-0.785,0,0.05,10034,39.3,-0.796,0,0.371,10039,39.4,-0.793,0,0.36,10040,39.4,-0.804,0,0.638,10055,40,-0.816,0,0.626,10056,40,-0.819,0,0.854,10059,40.2,-0.82,0,0.832,
10060,40.3,-0.82,0,1,10081,41.7,-0.837,0,0.979,10219,50.7,-0.603,0,1,10334,57.4,-0.048,0,1,10619,70.5,0.006,0,1,10857,78.1,0.026,0,1,10858,78.1,0.026,0,0.722,10872,78.1,0.026,0,0.672,11009,76.8,0.022,0,0.57
] };
const LN = LAP.steps, LV = new Float64Array(LN), LL = new Float64Array(LN), LB = new Float64Array(LN), LD = new Float64Array(LN);
(function () {
  const k = LAP.k;
  for (let j = 0; j + 5 < k.length; j += 5) {
    const a = k[j], b = k[j + 5];
    for (let i = a; i <= b; i++) {
      const f = (i - a) / (b - a);
      LV[i] = k[j + 1] + (k[j + 6] - k[j + 1]) * f; LL[i] = k[j + 2] + (k[j + 7] - k[j + 2]) * f;
      LB[i] = k[j + 3] + (k[j + 8] - k[j + 3]) * f; LD[i] = k[j + 4] + (k[j + 9] - k[j + 4]) * f;
    }
  }
})();
// Drive `laps` laps of it (fractions allowed); each(ty, lapsDone) after every step, a truthy result stops -> laps driven.
const lapLoad = load({});
function drive(ty, laps, each) {
  const n = Math.round(laps * LN);
  for (let s = 0; s < n; s++) {
    const i = s % LN;
    lapLoad.speed = LV[i]; lapLoad.lat = LL[i]; lapLoad.brake = LB[i]; lapLoad.drive = LD[i];
    ty.update(DT, lapLoad);
    if (each && each(ty, (s + 1) / LN)) return (s + 1) / LN;
  }
  return laps;
}
function checkSane(ty, what) {
  const s = ty.state;
  assert(['S', 'M', 'H'].includes(s.compound), what + ': compound ' + s.compound);
  for (const k of ['wear', 'flat', 'temp']) {
    assert(Array.isArray(s[k]) && s[k].length === 4, what + ': ' + k);
    for (const v of s[k]) assert(typeof v === 'number' && isFinite(v), what + ': ' + k + ' ' + v);
  }
  for (const v of s.wear.concat(s.flat, [s.dirt, s.vib])) assert(v >= 0 && v <= 1, what + ': share out of 0..1: ' + v);
  for (const v of s.temp) assert(v >= 80 && v <= 160, what + ': temp ' + v);
  assert([-1, 0, 1, 2, 3].includes(s.puncture), what + ': puncture ' + s.puncture);
  for (const k of ['lat', 'brake', 'traction']) {
    const g = s.grip[k];
    assert(typeof g === 'number' && g > 0.2 && g <= 1.015, what + ': grip.' + k + ' ' + g);
  }
}

test('module: node export, window.F1 API, a fresh medium set', () => {
  assert.strictEqual(typeof createTyres, 'function');
  assert.strictEqual(globalThis.F1.createTyres, createTyres, 'F1.createTyres');
  assert.strictEqual(globalThis.F1.Tyres, Tyres, 'F1.Tyres is the node export');
  assert.deepStrictEqual(Tyres.ORDER, ['S', 'M', 'H']);
  assert.deepStrictEqual(Object.keys(Tyres.NAMES), ['S', 'M', 'H']);
  for (const c of Tyres.ORDER) assert(/^#[0-9a-f]{6}$/.test(Tyres.COLOURS[c]), 'colour ' + c);
  const ty = createTyres();                               // no options: Math.random, medium, rate 1
  assert.deepStrictEqual(copy(ty.state), {
    compound: 'M', wear: [0, 0, 0, 0], flat: [0, 0, 0, 0], temp: [90, 90, 90, 90], dirt: 0, puncture: -1,
    grip: { lat: 1, brake: 1, traction: 1 }, vib: 0
  });
  assert.strictEqual(ty.wearRate, 1);
  const st = ty.state, wear = st.wear, grip = st.grip;
  ty.fit('S'); ty.update(DT, load({ speed: 50, lat: 0.5 })); ty.fit('M');
  assert(ty.state === st && st.wear === wear && st.grip === grip, 'state objects are kept (read them once, they stay live)');
});

test('reference condition: a new clean medium set in its window gives exactly 1 / 1 / 1', () => {
  const ty = fresh('M');
  assert.strictEqual(ty.state.grip.lat, 1); assert.strictEqual(ty.state.grip.brake, 1); assert.strictEqual(ty.state.grip.traction, 1);
  // wear rate 0 (tests): a whole lap, slides, the grass, impacts -> nothing moves, grip exactly 1 at every step
  const z = fresh('M', 0), before = copy(z.state);
  let exact = true;
  const chk = t => { const g = t.state.grip; if (g.lat !== 1 || g.brake !== 1 || g.traction !== 1) exact = false; };
  drive(z, 1, chk);
  run(z, 3, load({ speed: 40, lat: 1, slip: 1, brake: 1 }), chk);
  run(z, 2, load({ speed: 30, onGrass: true }), chk);
  run(z, 0.1, load({ speed: 50, hit: 1 }), chk);
  assert(exact, 'grip exactly 1 at rate 0');
  assert.deepStrictEqual(copy(z.state), before, 'state frozen at rate 0');
  // wear rate 1, hard racing: the first 20 % of wear costs nothing, the temperatures stay in the window ->
  // exactly 1 / 1 / 1 at every step of the first two laps (the reference car drives exactly as before)
  const r = fresh('M', 1);
  let steps = 0;
  drive(r, 2, t => { chk(t); steps++; });
  assert(exact, 'grip exactly 1 during two hard laps at rate 1');
  assert(maxWear(r) > 0.1 && maxWear(r) < 0.2, 'the tyres do wear meanwhile: ' + maxWear(r));
  assert(Math.max(...r.state.temp) > 90 && Math.max(...r.state.temp) < 100, 'working temperature ' + Math.max(...r.state.temp));
  assert.strictEqual(r.state.vib, 0);
  info('2 hard laps at rate 1: wear ' + r.state.wear.map(w => (w * 100).toFixed(1) + '%').join(' ') + ', grip exactly 1 in all ' + steps + ' steps');
});

test('compounds: soft +1.5 % grip / twice the wear, hard -1.5 % / half the wear; names, cycle', () => {
  const s = fresh('S'), h = fresh('H');
  assert.deepStrictEqual(copy(s.state.grip), { lat: 1.015, brake: 1.015, traction: 1.015 });
  assert.deepStrictEqual(copy(h.state.grip), { lat: 0.985, brake: 0.985, traction: 0.985 });
  assert.strictEqual(s.state.compound, 'S'); assert.strictEqual(h.state.compound, 'H');
  const m = fresh('M');
  for (const t of [s, m, h]) drive(t, 1);
  for (let i = 0; i < 4; i++) {
    assert(Math.abs(s.state.wear[i] / m.state.wear[i] - 2) < 1e-9, 'soft wears twice as fast: ' + W[i]);
    assert(Math.abs(h.state.wear[i] / m.state.wear[i] - 0.5) < 1e-9, 'hard half as fast: ' + W[i]);
  }
  const t = createTyres();
  for (const [arg, want] of [['soft', 'S'], ['s', 'S'], ['Hard', 'H'], ['h', 'H'], ['M', 'M'], ['medium', 'M'], ['x', 'M'], [null, 'M'],
                             [undefined, 'M'], [42, 'M'], [{}, 'M'], ['', 'M']]) {
    t.fit('S'); t.fit(arg);
    assert.strictEqual(t.state.compound, want, 'fit(' + JSON.stringify(arg) + ')');
  }
  assert.deepStrictEqual(['S', 'M', 'H'].map(nextCompound), ['M', 'H', 'S']);
  assert.strictEqual(nextCompound('bogus'), 'H', 'garbage counts as medium');
  assert.strictEqual(Tyres.NAMES.M, '中性胎');
});

test('wear follows the load: outside tyres in corners, fronts under braking, rears on the throttle, slides, grass', () => {
  const left = fresh('M'), right = fresh('M');
  run(left, 10, load({ speed: 50, lat: 0.9 }));            // left-hand corner: the right-hand tyres work
  run(right, 10, load({ speed: 50, lat: -0.9 }));
  const lw = left.state.wear, rw = right.state.wear;
  assert(lw[FR] > lw[FL] * 2 && lw[RR] > lw[RL] * 2, 'left turn wears the right side: ' + lw);
  assert.strictEqual(argMax(lw), FR, 'the outside front works hardest');
  for (const [a, b] of [[FL, FR], [RL, RR]]) {
    assert(Math.abs(lw[a] - rw[b]) < 1e-15 && Math.abs(lw[b] - rw[a]) < 1e-15, 'mirror image');
  }
  const brk = fresh('M');
  run(brk, 5, load({ speed: 60, brake: 1 }));
  const bw = brk.state.wear;
  assert(bw[FL] > 2 * bw[RL] && bw[FL] === bw[FR] && bw[RL] === bw[RR], 'braking wears the fronts: ' + bw);
  const thr = fresh('M');
  run(thr, 10, load({ speed: 30, drive: 1 }));
  const tw = thr.state.wear;
  assert(tw[RL] > 5 * tw[FL] && tw[RL] === tw[RR], 'traction wears the rears: ' + tw);
  const grip = fresh('M'), slide = fresh('M');
  run(grip, 3, load({ speed: 40, lat: 1 }));
  run(slide, 3, load({ speed: 40, lat: 1, slip: 0.5 }));
  assert(maxWear(slide) > 2 * maxWear(grip), 'sliding wears much faster: ' + maxWear(slide) + ' vs ' + maxWear(grip));
  const road = fresh('M'), grass = fresh('M');
  run(road, 3, load({ speed: 30 }));
  run(grass, 3, load({ speed: 30, onGrass: true }));
  assert(maxWear(grass) > 20 * maxWear(road) && maxWear(road) > 0, 'the grass scrubs: ' + maxWear(grass) + ' vs ' + maxWear(road));
  const stand = fresh('M');
  run(stand, 10, load({ speed: 0, lat: 1, brake: 1, drive: 1 }));
  assert.deepStrictEqual(stand.state.wear, [0, 0, 0, 0], 'no wear standing still');
  // the real lap (clockwise: mostly right-hand corners) wears a left-hand tyre most
  const lap = fresh('M');
  drive(lap, 1);
  assert([FL, RL].includes(argMax(lap.state.wear)), 'most worn on the left: ' + lap.state.wear);
  info('one lap of Albert Park (medium, rate 1): ' + lap.state.wear.map((w, i) => W[i] + ' ' + (w * 100).toFixed(2) + '%').join(', '));
});

test('grip versus wear: nothing below 20 %, < 1 % at 50 %, ~4 % at 75 %, then a cliff; continuous', () => {
  assert.strictEqual(wearLoss(0), 0); assert.strictEqual(wearLoss(0.2), 0);
  assert(wearLoss(0.3) > 0 && wearLoss(0.3) < 0.001);
  assert(Math.abs(wearLoss(0.5) - 0.008) < 1e-9, '50 %: ' + wearLoss(0.5));
  assert(Math.abs(wearLoss(0.75) - 0.04) < 1e-9, '75 %: ' + wearLoss(0.75));
  assert(wearLoss(0.9) > 0.1 && wearLoss(1) > 0.28 && wearLoss(1) < 0.35, 'cliff: ' + wearLoss(0.9) + ' ' + wearLoss(1));
  assert.strictEqual(wearLoss(1.2), wearLoss(1), 'no worse past 100 %');
  let prev = 0, jump = 0;
  for (let w = 0; w <= 1.0000001; w += 1e-4) { const l = wearLoss(w); assert(l >= prev, 'monotonic at ' + w); jump = Math.max(jump, l - prev); prev = l; }
  assert(jump < 1e-3, 'continuous, largest step per 0.01 % of wear: ' + jump);
  // the car along a real stint (medium, rate 1): multipliers when the most worn tyre passes 50 / 75 / 90 / 100 %
  const ty = fresh('M'), at = {};
  drive(ty, 40, t => {
    const m = maxWear(t);
    for (const p of [0.5, 0.75, 0.9, 1]) if (!at[p] && m >= p) at[p] = copy(t.state.grip);
    return m >= 1;
  });
  const worst = g => Math.min(g.lat, g.brake, g.traction);
  assert(worst(at[0.5]) > 0.99, '50 %: ' + JSON.stringify(at[0.5]));
  assert(worst(at[0.75]) > 0.95 && worst(at[0.75]) < 0.985, '75 %: ' + JSON.stringify(at[0.75]));
  assert(worst(at[0.9]) < 0.93, '90 %: ' + JSON.stringify(at[0.9]));
  assert(worst(at[1]) < 0.85, '100 %: ' + JSON.stringify(at[1]));
  info('car multipliers (lat / brake / traction) when the most worn tyre reaches ' + [0.5, 0.75, 0.9, 1].map(p => (p * 100) + ' %: ' +
    [at[p].lat, at[p].brake, at[p].traction].map(x => x.toFixed(3)).join(' / ')).join(';  '));
});

test('stint length on a real lap: S / M / H at wear rate 1, 2 and 5', () => {
  const res = {};
  for (const c of ['S', 'M', 'H']) {
    for (const rate of [1, 2, 5]) {
      const ty = fresh(c, rate);
      let l75 = 0;
      const l100 = drive(ty, 100, (t, x) => { const m = maxWear(t); if (!l75 && m >= 0.75) l75 = x; return m >= 1; });
      assert(l100 < 100, c + ' x' + rate + ' never wore out');
      assert.strictEqual(ty.state.puncture, -1, 'no puncture before 100 %');
      res[c + rate] = { l100, l75, km: l100 * LAP.len / 1000 };
    }
  }
  const M1 = res.M1.l100;
  assert(M1 > 13.5 && M1 < 16.5, 'medium at rate 1 lasts ~15 laps of a ~5 km track: ' + M1);
  const near = (a, b, what) => assert(Math.abs(a / b - 1) < 0.01, what + ': ' + a + ' vs ' + b);
  near(res.S1.l100, M1 / 2, 'soft: half');
  near(res.H1.l100, M1 * 2, 'hard: twice');
  for (const c of ['S', 'M', 'H']) { near(res[c + 2].l100, res[c + 1].l100 / 2, c + ' rate 2'); near(res[c + 5].l100, res[c + 1].l100 / 5, c + ' rate 5'); }
  for (const c of ['S', 'M', 'H']) {
    info(Tyres.NAMES[c] + ' ' + c + ': ' + [1, 2, 5].map(r => 'x' + r + ' ' + res[c + r].l100.toFixed(1) + ' laps (' + res[c + r].km.toFixed(0) +
      ' km; 4 % grip loss after ' + res[c + r].l75.toFixed(1) + ')').join(',  '));
  }
});

test('puncture from a worn-out tyre: after 100 %, on that tyre; big grip loss, strong vibration; fit() cures it', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const ty = fresh('M', 1, seeded(seed));
    let at100 = null, pAt = null;
    drive(ty, 25, (t, x) => {
      if (at100 === null && maxWear(t) >= 1) at100 = x;
      if (t.state.puncture >= 0) { pAt = x; return true; }
    });
    assert(at100 !== null && pAt !== null, 'seed ' + seed + ': punctured');
    assert(pAt > at100 && pAt - at100 < 2.5, 'seed ' + seed + ': within 2.5 laps of 100 %: ' + at100 + ' -> ' + pAt);
    assert.strictEqual(ty.state.wear[ty.state.puncture], 1, 'the punctured tyre is worn through');
    run(ty, 1, load({ speed: 60 }));
    const g = ty.state.grip, p = ty.state.puncture;
    if (p >= RL) assert(g.traction < 0.6, 'rear puncture: traction ' + g.traction);
    else assert(g.brake < 0.85, 'front puncture: braking ' + g.brake);
    assert(g.lat < 0.8, 'lateral ' + g.lat);
    assert(ty.state.vib > 0.8, 'strong vibration at speed: ' + ty.state.vib);
    run(ty, 60, load({ speed: 60, lat: 0.3 }));
    assert.strictEqual(ty.state.puncture, p, 'stays until the pit stop');
    ty.fit('H');
    assert.deepStrictEqual(copy(ty.state.grip), { lat: 0.985, brake: 0.985, traction: 0.985 });
    assert.strictEqual(ty.state.puncture, -1);
    if (seed === 1) info('seed 1: 100 % after ' + at100.toFixed(2) + ' laps, puncture (' + W[p] + ') after ' + pAt.toFixed(2));
  }
});

test('flat spots: lock-ups and hard impacts; vibration grows with speed, a little less braking; they never heal', () => {
  const ty = fresh('M');
  run(ty, 1, load({ speed: 40, lat: 0.6, brake: 1, slip: 0.8 }));   // locking up into a left-hand corner
  run(ty, 0.5, load({ speed: 40 }));
  const f = ty.state.flat;
  assert(f[FR] > 0.15 && f[FR] > f[FL] && f[FL] > f[RL] && f[FR] > f[RR], 'the fronts, most the loaded one: ' + f);
  assert(ty.state.grip.brake < 1 && ty.state.grip.brake > 0.97, 'a little less braking: ' + ty.state.grip.brake);
  assert(ty.state.grip.lat === 1 && ty.state.grip.traction === 1, 'lateral / traction untouched (wear still < 20 %, window)');
  const vib = v => { ty.update(DT, load({ speed: v })); return ty.state.vib; };
  const v0 = vib(0), v20 = vib(20), v50 = vib(50), v80 = vib(80);
  assert(v0 === 0 && v20 > 0.03 && v50 > v20 * 2 && v80 >= v50 && v80 <= 1, 'vibration grows with speed: ' + [v0, v20, v50, v80]);
  const keep = copy(ty.state.flat);
  run(ty, 120, load({ speed: 60, lat: 0.4 }));
  assert.deepStrictEqual(copy(ty.state.flat), keep, 'no healing');
  // light sliding does not flat-spot; understeer alone only a little
  const light = fresh('M');
  run(light, 10, load({ speed: 50, lat: 1, slip: 0.3 }));
  assert.deepStrictEqual(light.state.flat, [0, 0, 0, 0], 'slip 0.3: none');
  const under = fresh('M'), lock = fresh('M');
  run(under, 2, load({ speed: 40, lat: 1, slip: 0.6 }));
  run(lock, 2, load({ speed: 40, lat: 1, slip: 0.6, brake: 1 }));
  assert(Math.max(...under.state.flat) > 0 && Math.max(...under.state.flat) < Math.max(...lock.state.flat) / 4,
    'understeer without the brakes: a little (' + Math.max(...under.state.flat) + '), locked: ' + Math.max(...lock.state.flat));
  // impacts: a light touch nothing, a hard hit a flat spot on one tyre, phased in without a step
  const touch = fresh('M', 1, () => 0.5);
  touch.update(DT, load({ speed: 40, hit: 0.15 })); run(touch, 1, load({ speed: 40 }));
  assert.deepStrictEqual(touch.state.flat, [0, 0, 0, 0], 'hit 0.15: nothing');
  const hard = fresh('M', 1, () => 0.9);                 // wheel draw 0.9 -> RR, puncture draw 0.9 -> none
  let maxStep = 0, last = hard.state.grip.brake;
  const brakeStep = t => { maxStep = Math.max(maxStep, Math.abs(t.state.grip.brake - last)); last = t.state.grip.brake; };
  hard.update(DT, load({ speed: 40, hit: 0.5 })); brakeStep(hard);
  run(hard, 1, load({ speed: 40 }), brakeStep);
  assert(hard.state.flat[RR] > 0.2 && hard.state.flat[FL] === 0, 'hit 0.5 -> flat spot on RR: ' + hard.state.flat);
  assert.strictEqual(hard.state.puncture, -1);
  assert(maxStep < 0.001, 'phased in: largest step of the braking multiplier ' + maxStep);
  // grinding along the wall (the same impact over and over) counts once
  const grind = fresh('M', 1, () => 0.9);
  run(grind, 1, load({ speed: 40, hit: 0.3 }));
  assert(Math.abs(grind.state.flat[RR] - 0.08) < 1e-9, 'one impact: ' + grind.state.flat);
});

test('overheating: sustained sliding lifts a tyre above its window, grip drops, it cools back in the airflow', () => {
  const temps = [];
  const hard = fresh('M');
  drive(hard, 2, t => { temps.push(Math.max(...t.state.temp)); });
  assert(Math.max(...temps) < 100, 'hard racing stays in the window: ' + Math.max(...temps));
  const loss = {};
  for (const c of ['S', 'M', 'H']) {
    const ty = fresh(c), g0 = ty.state.grip.lat;
    run(ty, 6, load({ speed: 40, lat: 1, slip: 0.5 }));        // heavy understeer in a long left-hander
    const t = ty.state.temp;
    assert(argMax(t) === FR && t[FR] > 120, c + ': the outside front overheats: ' + t);
    loss[c] = 1 - ty.state.grip.lat / g0;
    assert(loss[c] > 0.015, c + ': lateral grip drops: ' + loss[c]);
    let back = null;
    run(ty, 20, load({ speed: 60, lat: 0.3 }), (tt, i) => {
      if (Math.max(...tt.state.temp) <= Tyres.COMPOUNDS[c].hot) { back = i * DT; return true; }
    });
    assert(back !== null && back < 10, c + ': back in the window after ' + back + ' s');
    run(ty, 0.1, load({ speed: 60 }));
    assert.strictEqual(ty.state.grip.lat, g0, c + ': full lateral grip again');
  }
  assert(loss.S > loss.M && loss.M > loss.H, 'the soft suffers most: ' + JSON.stringify(loss));
  // overheated tyres wear faster: the same second of cornering on a hot and on a cool set
  const hot = fresh('M'), cool = fresh('M');
  run(hot, 6, load({ speed: 40, lat: 1, slip: 0.5 }));
  run(cool, 6, load({ speed: 40, lat: 1 }));
  const h0 = hot.state.wear[FR], c0 = cool.state.wear[FR];
  run(hot, 1, load({ speed: 40, lat: 1 })); run(cool, 1, load({ speed: 40, lat: 1 }));
  const ratio = (hot.state.wear[FR] - h0) / (cool.state.wear[FR] - c0);
  assert(ratio > 1.3, 'an overheated tyre wears faster: x' + ratio);
  info('6 s of heavy understeer (slip 0.5, 40 m/s): lateral grip ' + ['S', 'M', 'H'].map(c => c + ' -' + (loss[c] * 100).toFixed(1) + '%').join(', ') +
    '; hard racing peaks at ' + Math.max(...temps).toFixed(1) + ' deg C; hot tyre wears x' + ratio.toFixed(2));
});

test('dirt: picked up on the grass, gone after a few seconds of asphalt', () => {
  const ty = fresh('M');
  run(ty, 1.5, load({ speed: 25, onGrass: true }));
  assert.strictEqual(ty.state.dirt, 1, 'fully dirty');
  const g = copy(ty.state.grip);
  assert(g.lat < 0.9 && g.brake < 0.9 && g.traction < 0.9, 'grip down: ' + JSON.stringify(g));
  let prev = g.lat, maxStep = 0, clean = null;
  run(ty, 8, load({ speed: 45 }), (t, i) => {
    maxStep = Math.max(maxStep, Math.abs(t.state.grip.lat - prev)); prev = t.state.grip.lat;
    if (i === Math.round(1 / DT)) assert(t.state.dirt > 0.3, 'still dirty after 1 s: ' + t.state.dirt);
    if (clean === null && t.state.dirt === 0) clean = (i + 1) * DT;
  });
  assert(clean !== null && clean > 2 && clean < 5, 'clean after ' + clean + ' s at 45 m/s');
  assert(ty.state.grip.lat === 1 && ty.state.grip.brake === 1 && ty.state.grip.traction === 1, 'exactly 1 again');
  assert(maxStep < 0.003, 'no step: ' + maxStep);
  const parked = fresh('M');
  run(parked, 5, load({ speed: 0, onGrass: true }));
  assert.strictEqual(parked.state.dirt, 0, 'standing on the grass picks nothing up');
  info('dirty tyres: grip ' + g.lat.toFixed(3) + ', clean after ' + clean.toFixed(2) + ' s at 45 m/s');
});

test('puncture from a heavy impact: chance grows with the hit, fronts most exposed; deflates, stays until the pit stop', () => {
  const ty = fresh('M', 1, () => 0.1);                     // wheel draw 0.1 -> FL, puncture draw 0.1 -> yes
  let maxStep = 0, last = copy(ty.state.grip);
  const gripStep = t => {
    for (const k of ['lat', 'brake', 'traction']) maxStep = Math.max(maxStep, Math.abs(t.state.grip[k] - last[k]));
    last = copy(t.state.grip);
  };
  ty.update(DT, load({ speed: 50, hit: 1 })); gripStep(ty);
  assert.strictEqual(ty.state.puncture, FL);
  run(ty, 1, load({ speed: 50 }), gripStep);
  assert(maxStep > 0 && maxStep < 0.01, 'deflates over ~0.5 s, largest step ' + maxStep);
  const turnR = copy((ty.update(DT, load({ speed: 50, lat: -0.8 })), ty.state.grip));   // the flat FL is the loaded one
  const turnL = copy((ty.update(DT, load({ speed: 50, lat: 0.8 })), ty.state.grip));
  assert(turnR.lat < 0.7 && turnL.lat > turnR.lat + 0.15, 'lateral: right-hand turn ' + turnR.lat + ', left ' + turnL.lat);
  assert(turnR.brake < 0.85 && turnR.traction === 1, 'braking down, traction (rears) untouched: ' + JSON.stringify(turnR));
  assert(ty.state.vib > 0.8, 'strong vibration: ' + ty.state.vib);
  // chance: nothing up to hit 0.4, ~40 % at 0.7 (0.8 * 0.5), fronts ~70 % of the time
  for (const h of [0.2, 0.3, 0.4]) {
    const t = fresh('M', 1, () => 0);
    t.update(DT, load({ speed: 50, hit: h }));
    assert.strictEqual(t.state.puncture, -1, 'hit ' + h + ' never punctures');
  }
  let n = 0, fronts = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const t = fresh('M', 1, seeded(seed * 7919));
    t.update(DT, load({ speed: 50, hit: 0.7 }));
    if (t.state.puncture >= 0) { n++; if (t.state.puncture < RL) fronts++; }
  }
  assert(n > 2000 * 0.34 && n < 2000 * 0.46, 'hit 0.7 punctures ~40 %: ' + n / 2000);
  assert(fronts / n > 0.62 && fronts / n < 0.78, 'fronts ~70 %: ' + fronts / n);
  info('hit 0.7: ' + (n / 20).toFixed(1) + ' % punctures, ' + (fronts / n * 100).toFixed(0) + ' % of them at the front');
});

test('wear rate 0 freezes everything; setWearRate sanitises', () => {
  const ty = fresh('M', 1, () => 0.1);
  drive(ty, 3);
  run(ty, 2, load({ speed: 40, lat: 1, slip: 0.8, brake: 1 }));
  run(ty, 1, load({ speed: 25, onGrass: true }));
  ty.setWearRate(0);
  assert.strictEqual(ty.wearRate, 0);
  const before = copy(ty.state);
  drive(ty, 2);
  run(ty, 2, load({ speed: 40, lat: 1, slip: 1, brake: 1 }));
  run(ty, 2, load({ speed: 25, onGrass: true }));
  run(ty, 0.2, load({ speed: 50, hit: 1 }));
  ty.update(DT, load({ speed: 0 }));
  const after = copy(ty.state);
  before.vib = after.vib = 0;                               // (vibration follows the speed fed in)
  before.grip = after.grip = null;                          // (lateral weighting follows the direction of the turn)
  assert.deepStrictEqual(after, before, 'wear, flat spots, temperatures, dirt, puncture all frozen');
  for (const [arg, want] of [[2, 2], [5, 5], [9, 5], [-3, 0], [0.5, 0.5], [NaN, 1], [Infinity, 1], ['3', 1], [null, 1], [undefined, 1]]) {
    ty.setWearRate(arg);
    assert.strictEqual(ty.wearRate, want, 'setWearRate(' + String(arg) + ')');
  }
});

test('deterministic with a seeded random', () => {
  function story(seed) {
    const ty = createTyres({ random: seeded(seed) });
    const out = [];
    ty.fit('S'); ty.setWearRate(5);
    drive(ty, 0.5);
    for (const h of [0.3, 0.6, 0.9, 0.5, 1]) { ty.update(DT, load({ speed: 50, hit: h })); run(ty, 1, load({ speed: 50, lat: 0.5 })); }
    drive(ty, 4, t => { out.push(t.state.puncture); });
    return { state: copy(ty.state), punct: out.join('') };
  }
  assert.deepStrictEqual(story(42), story(42), 'same seed, same run');
  const runs = [1, 2, 3, 4, 5, 6].map(s => JSON.stringify(story(s)));
  assert(new Set(runs).size > 1, 'the random draws matter');
});

test('garbage input never poisons the state', () => {
  const ty = createTyres({ random: () => NaN });            // a broken random() is tolerated too
  const bad = [NaN, Infinity, -Infinity, undefined, null, '12', {}, [], true, -1e308, 1e308];
  for (const dt of [NaN, -1, 0, Infinity, undefined, null, '0.01', 1e9]) { ty.update(dt, load({ speed: 50, lat: 1 })); checkSane(ty, 'dt ' + dt); }
  for (const l of [null, undefined, 5, 'x', [], { speed: NaN }, { lat: 'left' }, { brake: Infinity }]) { ty.update(DT, l); checkSane(ty, 'load ' + JSON.stringify(l)); }
  for (const k of ['speed', 'lat', 'brake', 'drive', 'slip', 'onGrass', 'hit']) {
    for (const v of bad) { ty.update(DT, Object.assign(load({ speed: 40, lat: 0.5 }), { [k]: v })); checkSane(ty, k + ' = ' + String(v)); }
  }
  ty.update(DT, load({ speed: -70, lat: 7, brake: 3, drive: -2, slip: 9, hit: 5 }));   // reverse, out of range
  checkSane(ty, 'out of range');
  ty.setWearRate(5); drive(ty, 10); checkSane(ty, 'worn out at x5');
  ty.fit({}); checkSane(ty, 'fit garbage');
  assert.strictEqual(ty.state.compound, 'M');
  // a year of racing at x5 on softs with every kind of abuse still gives sane numbers
  const t2 = fresh('S', 5, seeded(3));
  for (let k = 0; k < 20; k++) {
    drive(t2, 1); run(t2, 1, load({ speed: 45, lat: -1, slip: 1, brake: 1 })); run(t2, 1, load({ speed: 30, onGrass: true }));
    t2.update(DT, load({ speed: 60, hit: 1 })); checkSane(t2, 'abuse ' + k);
  }
});

test('the multipliers are continuous in time (only a puncture may move them quickly)', () => {
  const ty = fresh('S', 5, () => 0.99);                    // impacts never puncture with 0.99; wear goes over the cliff
  let prev = null, maxStep = 0, where = '';
  const watch = (what) => (t) => {
    const g = t.state.grip;
    if (prev && Math.abs(lapLoad.lat - prev.l) < 0.02 && t.state.puncture < 0) {
      for (const k of ['lat', 'brake', 'traction']) {
        const d = Math.abs(g[k] - prev[k]);
        if (d > maxStep) { maxStep = d; where = what + ' ' + k; }
      }
    }
    prev = { lat: g.lat, brake: g.brake, traction: g.traction, l: lapLoad.lat };
  };
  let events = 0, overCliff = false;
  drive(ty, 2.2, (t, x) => {
    watch('lap')(t);
    if (t.state.puncture < 0 && maxWear(t) >= 0.99) overCliff = true;
    const i = Math.round(x * LN) % LN;
    if (i === 3000 || i === 7000) {                          // off onto the grass and back, a hit, a slide
      events++;
      const w = watch('event');
      const keep = Object.assign({}, lapLoad);
      Object.assign(lapLoad, { speed: 30, onGrass: true }); run(t, 1.5, lapLoad, w);
      Object.assign(lapLoad, { onGrass: false, speed: 40, hit: 0.35 }); t.update(DT, lapLoad); w(t);
      Object.assign(lapLoad, { hit: 0, lat: 0.9, slip: 0.7, brake: 0.5 }); run(t, 2, lapLoad, w);
      Object.assign(lapLoad, keep);
    }
  });
  assert.strictEqual(events, 4);
  assert(maxWear(ty) === 1 && overCliff, 'went over the cliff before any puncture: ' + ty.state.wear);
  assert(maxStep < 0.003, 'largest step of a multiplier in one 1/120 s step: ' + maxStep + ' (' + where + ')');
  info('largest step of a multiplier per 1/120 s (no puncture, ' + events + ' events, soft x5 over the cliff): ' + maxStep.toFixed(5) + ' (' + where + ')');
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall tyres tests passed');
process.exit(failed ? 1 : 0);

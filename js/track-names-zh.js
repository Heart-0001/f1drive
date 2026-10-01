// F1Drive - Traditional Chinese (Taiwan usage) names of the 40 circuits in tracks-data.js, for the track cards and
// the track search (typing 鈴鹿 must find jp-1962). Data only: no DOM, no THREE; safe to load in node.
//
//   window.F1_TRACK_NAMES_ZH = {
//     '<track id>': {          every id of window.F1_TRACKS (tracks-data.js), exactly once
//       name,                  the circuit's name as Taiwanese F1 coverage writes it
//       short,                 the one-word handle for compact lists (usually the place, e.g. 鈴鹿, 蒙札, 銀石)
//       location,              '<country> <place>', Taiwan usage (澳洲, 義大利, 沙烏地阿拉伯, 卡達, 亞塞拜然 ...)
//       aliases: [ ... ]       extra search strings only, never displayed: the zh-tw Wikipedia form where it differs,
//                              other spellings seen in Taiwanese media, mainland China / Hong Kong forms (in
//                              simplified and / or traditional characters), and a few ASCII forms of names whose
//                              English spelling has diacritics (Portimao, Nurburgring ...)
//       layout                 (optional) the card's tooltip where tracks-data.js has a `layout` note (the layout the
//                              game builds is not the one the name suggests: Estoril), in Chinese
//     }, ...
//   }
//
// Search: keep the English name, location and id in the search key and add name + short + location + aliases.
// Lower-case the whole key (some aliases are ASCII). Every name / short with a middle dot also has a dot-less alias
// (吉爾維倫紐夫賽道 ...), so a plain substring match works. If you normalise, map the other middle dots to '·' in both
// the query and the key: '‧' (U+2027, the Big5 / Taiwanese IME dot), '．' (U+FF0E, what Sports Vision writes),
// '・' (U+30FB), '･' (U+FF65), '•' (U+2022); and the dashes '–' '—' '－' to '-'. Do NOT strip the dot: '卡洛斯·帕塞'
// would become '卡洛斯帕塞' and match a search for 斯帕.
//
// Sources (checked 2026-10-01). Taiwanese F1 coverage first:
//   SV  = 運動視界 Sports Vision (sportsv.net), the "F1賽道簡介" series (https://www.sportsv.net/feature/329) and
//         other GP previews, e.g. articles 19925 (鈴鹿賽道), 33452 (蒙札賽道), 87857 (贊德沃特賽道), 26771 (亞伯特公園賽道)
//   UC  = U-CAR F1 (f1.u-car.com.tw) season calendars: GP / country names (沙烏地阿拉伯站, 亞塞拜然站, 卡達站 ...)
//   UDN = 聯合報 autos.udn.com, LTN = 自由時報, ET = ETtoday, CNA = 中央社
//   WP  = zh.wikipedia.org title in the zh-tw variant (used where Taiwan has no established form; marked "WP only");
//         "WP zh-hans" marks the unconverted / mainland title where it differs
// Checked again 2026-10-01 by an independent pass (zh-tw titles via the MediaWiki API, variant=zh-tw; the Sports
// Vision citations re-counted): de-1932 now 霍肯海姆 (was 霍根海姆), qa-2004 location 盧塞爾 (was 盧賽爾); WP notes fixed.
// The per-entry comment names the source of `name` (and of the place in `location` when it is not obvious).
(function (root) {
  'use strict';

  var NAMES = {
    'au-1953': { // Albert Park Circuit. name: SV 26771 (亞伯特公園賽道); WP 阿爾伯特公園賽道
      name: '亞伯特公園賽道', short: '墨爾本', location: '澳洲 墨爾本',
      aliases: ['阿爾伯特公園賽道', '亞伯特公園', '阿尔伯特公园赛道', '墨尔本', '澳大利亞', '澳大利亚']
    },
    'pt-1972': { // Autódromo do Estoril. name: SV 78452 (艾斯托利爾賽道); WP 埃斯托里爾賽道 (WP zh-hans 埃什托里尔赛道)
      name: '艾斯托利爾賽道', short: '艾斯托利爾', location: '葡萄牙 艾斯托利爾',
      aliases: ['埃斯托里爾賽道', '埃什托里爾賽道', '埃斯托利爾', '埃什托里尔赛道', '埃斯托里尔赛道', '卡斯凱什'],
      layout: '2000 年改建後的賽道佈局（F1 在 1984–96 年用的是舊佈局）'   // tracks-data.js trackData.layout in Chinese
    },
    'it-1953': { // Autodromo Enzo e Dino Ferrari. name: SV 78617 (伊莫拉賽道 / 恩佐與帝諾．法拉利賽道); WP 安佐與迪諾·法拉利賽道
      name: '伊莫拉賽道', short: '伊莫拉', location: '義大利 伊莫拉',
      aliases: ['恩佐與迪諾·法拉利賽道', '恩佐與迪諾法拉利賽道', '恩佐與帝諾·法拉利賽道', '安佐與迪諾·法拉利賽道',
        '伊莫拉赛道', '恩佐与迪诺·法拉利赛道', '艾密利亞-羅馬那', '艾米利亞-羅馬涅', '艾米利亚-罗马涅', '聖馬利諾', '圣马力诺']
    },
    'mx-1962': { // Autódromo Hermanos Rodríguez. name: SV 21804 + WP (羅德里格斯兄弟賽道); 墨西哥城: SV 21804 (墨西哥城GP),
      //            UDN, WP zh-tw; 墨西哥市 (CNA / MOFA general usage) is an alias
      name: '羅德里格斯兄弟賽道', short: '墨西哥城', location: '墨西哥 墨西哥城',
      aliases: ['羅氏兄弟賽道', '墨西哥市', '罗德里格斯兄弟赛道', 'Hermanos Rodriguez']
    },
    'pt-2008': { // Autódromo Internacional do Algarve. name: SV 78452 + WP (阿爾加維國際賽道); 波爾蒂芒: SV + WP
      name: '阿爾加維國際賽道', short: '波爾蒂芒', location: '葡萄牙 波爾蒂芒',
      aliases: ['阿爾加維賽道', '阿爾加維', '阿尔加维国际赛道', '波尔蒂芒', 'Portimao']
    },
    'br-1977': { // Autódromo Internacional Nelson Piquet (Jacarepaguá). name: SV 22539 (雅卡雷帕瓜-皮奎特賽道);
      //            WP has no article (WP "1989年巴西大獎賽": 雅卡雷帕瓜的尼爾森·畢奇國際賽道)
      name: '雅卡雷帕瓜賽道', short: '雅卡雷帕瓜', location: '巴西 里約熱內盧',
      aliases: ['雅卡雷帕瓜-皮奎特賽道', '尼爾森·皮奎特國際賽道', '皮奎特賽道', '尼爾森·畢奇國際賽道', '里約',
        '雅卡雷帕瓜赛道', '尼尔森·皮奎特赛道', '里约热内卢', 'Jacarepagua']
    },
    'it-1914': { // Autodromo Internazionale del Mugello. name: SV 77295 (穆傑羅賽道 / 穆傑羅國際賽道); WP 穆傑洛賽道;
      //            place: the comune Scarperia e San Piero, WP 斯卡爾佩里亞和聖皮耶羅
      name: '穆傑羅賽道', short: '穆傑羅', location: '義大利 斯卡爾佩里亞',
      aliases: ['穆傑羅國際賽道', '穆傑洛賽道', '穆杰罗赛道', '穆杰洛赛道', '托斯卡尼', '托斯卡纳', '斯卡爾佩里亞和聖皮耶羅']
    },
    'br-1940': { // Autódromo José Carlos Pace - Interlagos. name: SV 22539 (英特拉哥斯賽道, 荷西．卡洛斯．帕瑟);
      //            WP 若澤·卡洛斯·帕塞賽道 (舊稱英特拉格斯賽道)
      name: '英特拉哥斯賽道', short: '英特拉哥斯', location: '巴西 聖保羅',
      aliases: ['荷西·卡洛斯·帕瑟賽道', '若澤·卡洛斯·帕塞賽道', '卡洛斯·帕塞賽道', '英特拉格斯', '因特拉格斯',
        '英特拉格斯赛道', '若泽·卡洛斯·帕塞赛道', '圣保罗']
    },
    'it-1922': { // Autodromo Nazionale Monza. name: SV 33452 (蒙札賽道, 國立蒙札賽道); WP 國立蒙札賽車場
      //            (WP zh-hans 蒙扎国家赛车场)
      name: '蒙札賽道', short: '蒙札', location: '義大利 蒙札',
      aliases: ['國立蒙札賽車場', '蒙札國家賽車場', '國立蒙札賽道', '蒙扎國家賽車場', '蒙扎', '蒙薩', '蒙扎赛道', '蒙扎国家赛车场']
    },
    'ar-1952': { // Autódromo Oscar y Juan Gálvez. name: WP only (胡安與奧斯卡·加爾韋斯賽道); UDN 9467052: 加爾韋斯賽車場
      name: '胡安與奧斯卡·加爾韋斯賽道', short: '布宜諾斯艾利斯', location: '阿根廷 布宜諾斯艾利斯',
      aliases: ['胡安與奧斯卡加爾韋斯賽道', '奧斯卡與胡安·加爾韋斯賽道', '加爾韋斯賽車場', '加爾韋斯賽道',
        '胡安与奥斯卡·加尔韦斯赛道', '加尔韦斯', 'Galvez']
    },
    'bh-2002': { // Bahrain International Circuit. name: SV 27512 + WP (巴林國際賽道); 薩基爾: SV 27512 + WP
      name: '巴林國際賽道', short: '巴林', location: '巴林 薩基爾',
      aliases: ['巴林賽道', '薩基爾賽道', '巴林国际赛道', '萨基尔']
    },
    'az-2016': { // Baku City Circuit. name: WP (巴庫市街賽道); SV 30791 巴庫市賽道 / 巴庫賽道; 亞塞拜然: UC
      name: '巴庫市街賽道', short: '巴庫', location: '亞塞拜然 巴庫',
      aliases: ['巴庫賽道', '巴庫市賽道', '巴庫城市賽道', '巴库城市赛道', '巴库市街赛道', '巴库', '阿塞拜疆']
    },
    'es-1991': { // Circuit de Barcelona-Catalunya. name: SV 29398 + WP (巴塞隆納-加泰隆尼亞賽道)
      name: '巴塞隆納-加泰隆尼亞賽道', short: '巴塞隆納', location: '西班牙 巴塞隆納',
      aliases: ['加泰隆尼亞賽道', '巴賽隆納', '巴塞隆拿', '巴塞罗那-加泰罗尼亚赛道', '加泰罗尼亚赛道', '巴塞罗那', '蒙特梅洛']
    },
    'mc-1929': { // Circuit de Monaco. name: SV 29945 + WP (摩納哥賽道, 一般稱蒙地卡羅賽道); 蒙地卡羅: SV, UDN
      name: '摩納哥賽道', short: '摩納哥', location: '摩納哥 蒙地卡羅',
      aliases: ['蒙地卡羅賽道', '摩納哥市街賽道', '蒙特卡洛', '蒙特卡羅', '摩纳哥赛道', '蒙特卡洛赛道', 'Monte Carlo']
    },
    'fr-1960': { // Circuit de Nevers Magny-Cours. name: WP only (馬尼庫爾賽道; the town: 馬尼-庫爾)
      name: '馬尼庫爾賽道', short: '馬尼庫爾', location: '法國 馬尼庫爾',
      aliases: ['訥韋爾馬尼庫爾賽道', '馬尼-庫爾', '马尼库尔赛道', '马尼-库尔', 'Magny Cours']
    },
    'be-1925': { // Circuit de Spa-Francorchamps. name: SV 105133 + 19925 (斯帕–法蘭柯爾尚賽道), SV 33257 (斯帕賽道;
      //            it writes 斯帕–法蘭科爾尚); WP + LightsOut 斯帕-弗朗科爾尚賽道
      name: '斯帕-法蘭柯爾尚賽道', short: '斯帕', location: '比利時 斯帕',
      aliases: ['斯帕賽道', '斯帕-法蘭科爾尚賽道', '斯帕-弗朗科爾尚賽道', '法蘭柯爾尚', '弗朗科爾尚',
        '斯帕-弗朗科尔尚赛道', '斯帕赛道']
    },
    'ca-1978': { // Circuit Gilles-Villeneuve. name: SV 28764 + WP (吉爾·維倫紐夫賽道); 蒙特婁: SV 30456 + WP zh-tw
      name: '吉爾·維倫紐夫賽道', short: '蒙特婁', location: '加拿大 蒙特婁',
      aliases: ['吉爾維倫紐夫賽道', '維倫紐夫賽道', '韋倫紐夫賽道', '蒙特婁賽道', '吉尔·维伦纽夫赛道', '蒙特利尔',
        '蒙特利爾', '聖母島']
    },
    'us-2012': { // Circuit of the Americas. name: SV 21408 + WP (美洲賽道); 奧斯汀 / 德州: SV 21408
      name: '美洲賽道', short: '奧斯汀', location: '美國 奧斯汀',
      aliases: ['德州', '德克薩斯', '美洲赛道', '奥斯汀', '得克萨斯', 'COTA']
    },
    'fr-1969': { // Circuit Paul Ricard. name: SV 52818 (保羅．里卡爾賽道, 標籤 保羅里卡爾賽道); WP 保羅·理察賽道
      //            (WP zh-hans 保罗·里卡尔赛道); 勒卡斯特雷: SV 52818 (WP 勒卡斯特萊)
      name: '保羅·里卡爾賽道', short: '保羅·里卡爾', location: '法國 勒卡斯特雷',
      aliases: ['保羅里卡爾賽道', '保羅·理察賽道', '保羅理察賽道', '保羅·里卡德賽道', '勒卡斯特萊', '保罗·里卡尔赛道',
        '保罗·里卡德赛道', '保罗里卡德']
    },
    'nl-1948': { // Circuit Zandvoort. name: SV 87857 / 109265 + WP (贊德沃特賽道); WP zh-hans 赞德福特赛道
      name: '贊德沃特賽道', short: '贊德沃特', location: '荷蘭 贊德沃特',
      aliases: ['贊德福特賽道', '贊德福特', '赞德沃特赛道', '赞德福特赛道', '尼德蘭']
    },
    'es-2026': { // Circuito de Madring. name: SV 109265 / 128387 (馬德里賽道); WP 馬德里環賽道
      name: '馬德里賽道', short: '馬德里', location: '西班牙 馬德里',
      aliases: ['馬德里環賽道', '马德里赛道', '马德里环赛道']
    },
    'de-1932': { // Hockenheimring. name: SV 32372 (the 賽道簡介 series: 霍肯海姆 x10), ET 2024-04-01, WP (霍肯海姆賽道;
      //            its 各地譯名 table: 臺灣 霍肯海姆). 霍根海姆 (Baidu / mainland sites; also UDN 2019 and SV 65577, a
      //            Red Bull-authored piece) and HK 賀根咸 are aliases
      name: '霍肯海姆賽道', short: '霍肯海姆', location: '德國 霍肯海姆',
      aliases: ['霍根海姆賽道', '霍根海姆', '賀根咸', '霍根海姆赛道', '霍肯海姆赛道']
    },
    'hu-1986': { // Hungaroring. name: SV 32134 + WP (匈牙利賽道); 布達佩斯: SV 32134
      name: '匈牙利賽道', short: '匈牙利賽道', location: '匈牙利 布達佩斯',
      aliases: ['亨格羅寧賽道', '亨格羅寧', '亨格罗宁赛道', '匈牙利赛道', '莫焦羅德', '布达佩斯']
    },
    'us-1909': { // Indianapolis Motor Speedway. name: CNA (印第安納波利斯賽車場); WP 印第安納波利斯賽道
      name: '印第安納波利斯賽車場', short: '印第安納波利斯', location: '美國 印第安納波利斯',
      aliases: ['印第安納波利斯賽道', '印地安納波利斯', '印地賽道', '印地500', '印第安纳波利斯赛道', '印第安纳波利斯赛车场']
    },
    'tr-2005': { // Intercity Istanbul Park. name: SV 78909 (伊斯坦堡賽道); WP 伊斯坦堡賽車場 / 伊斯坦堡賽道
      name: '伊斯坦堡賽道', short: '伊斯坦堡', location: '土耳其 伊斯坦堡',
      aliases: ['伊斯坦堡公園賽道', '伊斯坦堡賽車場', '伊斯坦布爾', '伊斯坦布尔公园赛道', '伊斯坦布尔赛道', '圖茲拉']
    },
    'sa-2021': { // Jeddah Corniche Circuit. name: SV 90293 + WP (吉達濱海賽道); 沙烏地阿拉伯: UC
      name: '吉達濱海賽道', short: '吉達', location: '沙烏地阿拉伯 吉達',
      aliases: ['吉達賽道', '吉达滨海赛道', '吉达街道赛道', '吉达', '沙特阿拉伯', '沙地阿拉伯']
    },
    'za-1961': { // Kyalami Grand Prix Circuit. name: SV 48677 / 103978 (卡亞拉米賽道); WP 卡亞拉米大獎賽賽道;
      //            約翰尼斯堡: SV 103978 + WP zh-tw
      name: '卡亞拉米賽道', short: '卡亞拉米', location: '南非 約翰尼斯堡',
      aliases: ['卡亞拉米大獎賽賽道', '凱拉米賽道', '卡亚拉米赛道', '凯拉米赛道', '約翰內斯堡', '约翰内斯堡', '米德蘭']
    },
    'us-2023': { // Las Vegas Street Circuit. name: SV 107849 (拉斯維加斯市街賽道); WP 拉斯維加斯大道賽道
      name: '拉斯維加斯市街賽道', short: '拉斯維加斯', location: '美國 拉斯維加斯',
      aliases: ['拉斯維加斯大道賽道', '賭城大道', '賭城', '拉斯维加斯街道赛道', '拉斯维加斯大道赛道', '拉斯维加斯']
    },
    'qa-2004': { // Losail International Circuit. name: SV 89947 + WP (羅賽爾國際賽道); the city Lusail: CNA 202211010118
      //            (盧塞爾, 盧塞爾地標體育場); WP zh-tw 羅賽爾, WP zh-hans 路薩爾, mainland 卢赛尔
      name: '羅賽爾國際賽道', short: '羅賽爾', location: '卡達 盧塞爾',
      aliases: ['羅賽爾賽道', '盧賽爾國際賽道', '盧賽爾', '路薩爾', '卢赛尔国际赛道', '罗赛尔国际赛道', '卢赛尔', '卡塔尔', '卡塔爾']
    },
    'sg-2008': { // Marina Bay Street Circuit. name: SV 19591 + WP (濱海灣市街賽道, 濱海灣賽道)
      name: '濱海灣市街賽道', short: '濱海灣', location: '新加坡 濱海灣',
      aliases: ['濱海灣賽道', '滨海湾街道赛道', '滨海湾市街赛道', '滨海湾']
    },
    'us-2022': { // Miami International Autodrome. name: SV 94025 + WP (邁阿密國際賽道); 邁阿密花園 / 硬石球場: SV 94025
      name: '邁阿密國際賽道', short: '邁阿密', location: '美國 邁阿密',
      aliases: ['邁阿密國際賽車場', '邁阿密賽道', '迈阿密国际赛道', '迈阿密国际赛车场', '迈阿密', '邁阿密花園', '硬石球場']
    },
    'de-1927': { // Nürburgring. name: LTN (紐柏林賽道), SV 126351 (紐柏林); SV 78098 紐堡林 / 紐堡村;
      //            UDN 紐柏林 (8324/3957358, 8324/1867441), ET 紐柏林; WP 紐柏林賽道 (WP zh-hans 纽博格林赛道);
      //            the village: WP 紐堡 (WP zh-hans 尼尔堡)
      name: '紐柏林賽道', short: '紐柏林', location: '德國 紐堡',
      aliases: ['紐堡林賽道', '紐伯林', '紐博格林賽道', '紐博格林', '纽博格林赛道', '纽博格林', '尼爾堡', 'Nurburgring']
    },
    'at-1969': { // Red Bull Ring. name: SV 31396 + WP (紅牛賽道); 斯皮爾伯格: SV 31396 (WP 斯皮爾堡, WP zh-hans 施皮尔贝格)
      name: '紅牛賽道', short: '紅牛賽道', location: '奧地利 斯皮爾伯格',
      aliases: ['紅牛環', '奧地利賽道', 'A1賽道', '斯皮爾堡', '施皮爾貝格', '红牛赛道', '红牛环赛道', '斯皮尔伯格']
    },
    'my-1999': { // Sepang International Circuit. name: UDN 9653645, CNA + WP (雪邦國際賽道)
      name: '雪邦國際賽道', short: '雪邦', location: '馬來西亞 雪邦',
      aliases: ['雪邦賽道', '雪邦国际赛道', '吉隆坡']
    },
    'cn-2004': { // Shanghai International Circuit. name: WP (上海國際賽車場, the official name); SV 28037 上海賽道 / 上賽道
      name: '上海國際賽車場', short: '上海', location: '中國 上海',
      aliases: ['上海國際賽道', '上海賽道', '上賽道', '上海国际赛车场', '上海国际赛道', '嘉定']
    },
    'gb-1948': { // Silverstone Circuit. name: SV 31707 + WP (銀石賽道)
      name: '銀石賽道', short: '銀石', location: '英國 銀石',
      aliases: ['銀石賽車場', '银石赛道', '银石']
    },
    'ru-2014': { // Sochi Autodrom (renamed Sirius Autodrom). name: SV 28764 + WP (索契賽道)
      name: '索契賽道', short: '索契', location: '俄羅斯 索契',
      aliases: ['索契奧林匹克公園賽道', '索契赛道', '索契奥林匹克公园赛道', 'Sirius']
    },
    'jp-1962': { // Suzuka International Racing Course. name: SV 19925, LTN 5386450, ET + WP (鈴鹿賽道);
      //            U-CAR 鈴鹿賽車場
      name: '鈴鹿賽道', short: '鈴鹿', location: '日本 鈴鹿',
      aliases: ['鈴鹿國際賽車場', '鈴鹿賽車場', '铃鹿赛道', '铃鹿', '三重縣', '三重县']
    },
    'us-1956': { // Watkins Glen International (town of Dix, NY). name: WP only (華金谷國際賽道; the village: WP 華金谷)
      name: '華金谷國際賽道', short: '華金谷', location: '美國 華金谷',
      aliases: ['華金谷賽道', '沃特金斯格倫', '沃特金斯格伦', '华金谷国际赛道', '紐約州', '纽约州', '迪克斯']
    },
    'ae-2009': { // Yas Marina Circuit. name: SV 23206 + WP (亞斯碼頭賽道); 阿布達比: SV + WP zh-tw; 阿聯 = 阿拉伯聯合大公國 (UC)
      name: '亞斯碼頭賽道', short: '亞斯碼頭', location: '阿聯 阿布達比',
      aliases: ['亞斯島', '亚斯码头赛道', '阿布扎比', '阿拉伯聯合大公國', '阿聯酋', '阿联酋']
    }
  };

  root.F1_TRACK_NAMES_ZH = NAMES;
  if (typeof module !== 'undefined' && module.exports) module.exports = NAMES;
})(typeof window !== 'undefined' ? window : globalThis);

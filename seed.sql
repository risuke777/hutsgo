-- HutsGo PoC seed: 表銀座 → 槍 → 穂高 の縦走ライン 21軒
--
-- IMPORTANT / データの出自について
--   2026-09-13 に各小屋の公式サイトを個別に確認し、確認できた行は
--   confidence='verified' + source_url=公式URL に昇格させた。
--   公式サイトに 2026 年の記載が無い行は二次情報（山と溪谷オンライン）由来のまま
--   confidence='reported' で残している。推測で埋めない。
--
-- 標高 (huts.elevation_m)
--   elevation_source='official' … 公式サイトの記載値（12軒）
--   elevation_source='gsi'      … 国土地理院 標高API（平地の宿 2 軒のみ。稜線の小屋は
--                                  地名検索の座標が建物とずれて 200m 近く外れるため使わない）
--   NULL                        … 公式に記載なし → サイトでは「標高未確認」と表示する
--
-- 座標は山域単位の概略値。実測 or 地理院データで置換予定。

BEGIN;

INSERT INTO mountain_ranges (id, name_ja, name_en) VALUES
  ('kita_alps', '北アルプス', 'Northern Japan Alps'),
  ('dolomites', 'ドロミティ', 'Dolomites');   -- 準備中: Alta Via 1 のリフージオを同じ形で載せる

INSERT INTO sub_areas (id, range_id, name_ja, name_en) VALUES
  ('omote_ginza',  'kita_alps', '表銀座・常念山脈', 'Omote-Ginza'),
  ('yari_hotaka',  'kita_alps', '槍ヶ岳・穂高連峰', 'Yari-Hotaka'),
  ('kamikochi',    'kita_alps', '上高地',           'Kamikochi');

INSERT INTO operators (id, name_ja, website, booking_system) VALUES
  ('enzanso',   '燕山荘グループ',   'https://www.enzanso.co.jp/',     'enzanso-reservation.jp'),
  ('yarigatake','槍ヶ岳山荘グループ','https://www.yarigatake.co.jp/',  'yarigatake.net'),
  ('chougatake','蝶ヶ岳ヒュッテ',   'https://chougatake.com/',        NULL),
  ('karasawa_h','涸沢ヒュッテ',     'https://karasawa-hyutte.com/',   NULL),
  ('indep',     '独立運営',         NULL,                             NULL);

-- huts -----------------------------------------------------------
-- 標高の出典（公式）:
--   有明荘 1380 / 燕山荘 2712 / 大天荘 2870 / ヒュッテ西岳 2680 / ヒュッテ大槍 2884 : enzanso.co.jp 各小屋ページ
--   常念小屋 2450 : mt-jonen.com/about/ 「標高2,450mの常念乗越の西側」
--   横尾山荘 1620 : yokoo-sanso.co.jp（ロゴ表記 YOKOO-SANSO 1620）
--   涸沢小屋 2350 : karasawagoya.com/about/ 「標高２３５０ｍの南斜面」
--   北穂高小屋 3100 : kitaho.co.jp/information 「located 3100m above sea level」
--   穂高岳山荘 2996 : hotakadakesanso.com/about/company 「白出のコル（2,996m）に位置」
--   西穂山荘 2367 : nishiho.com/about.htm 「当山荘は標高２３６７ｍの高地」
--   中房温泉 1461 / 徳澤園 1560 : 国土地理院 標高API（地名検索座標、5mレーザ）
--   蝶ヶ岳ヒュッテ: 公式は「標高2,677mの蝶ヶ岳山頂直下」= 山頂値のため小屋の標高としては未確認
--   槍ヶ岳山荘・殺生小屋・槍沢ロッヂ・南岳小屋・大天井ヒュッテ・岳沢小屋・涸沢ヒュッテ: 公式に記載なし
INSERT INTO huts (id,name_ja,hut_type,range_id,sub_area_id,operator_id,lat,lon,elevation_m,elevation_source,official_url,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen','中房温泉','onsen','kita_alps','omote_ginza','indep',36.394803,137.747765,1461,'gsi','https://nakabusa.com/','https://nakabusa.com/','2026-09-13','verified'),
('ariakeso','有明荘','lodge','kita_alps','omote_ginza','enzanso',36.390663,137.749111,1380,'official','https://www.enzanso.co.jp/ariakeso','https://www.enzanso.co.jp/ariakeso','2026-09-13','verified'),
('enzanso','燕山荘','mountain_hut','kita_alps','omote_ginza','enzanso',36.399506,137.715208,2712,'official','https://www.enzanso.co.jp/enzanso','https://www.enzanso.co.jp/enzanso','2026-09-13','verified'),
('daitenso','大天荘','mountain_hut','kita_alps','omote_ginza','enzanso',36.363749,137.700974,2870,'official','https://www.enzanso.co.jp/daitenso','https://www.enzanso.co.jp/daitenso','2026-09-13','verified'),
('otenjo_hutte','大天井ヒュッテ','mountain_hut','kita_alps','omote_ginza','yarigatake',36.365025,137.700359,NULL,NULL,'https://www.yarigatake.co.jp/otenjo/','https://www.yarigatake.co.jp/otenjo/','2026-09-13','verified'),
('hutte_nishidake','ヒュッテ西岳','mountain_hut','kita_alps','omote_ginza','enzanso',36.335603,137.680121,2680,'official','https://www.enzanso.co.jp/hutte-nishidake','https://www.enzanso.co.jp/hutte-nishidake','2026-09-13','verified'),
('jonen_goya','常念小屋','mountain_hut','kita_alps','omote_ginza','indep',36.333571,137.727567,2450,'official','http://www.mt-jonen.com/','http://www.mt-jonen.com/about/','2026-09-13','verified'),
('chougatake_hutte','蝶ヶ岳ヒュッテ','mountain_hut','kita_alps','omote_ginza','chougatake',36.287923,137.724907,NULL,NULL,'https://chougatake.com/','https://chougatake.com/stay/','2026-09-13','verified'),
('yarigatake_sanso','槍ヶ岳山荘','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.340849,137.642337,NULL,NULL,'https://www.yarigatake.co.jp/yarigatake/','https://www.yarigatake.co.jp/yarigatake/','2026-09-13','verified'),
('hutte_ooyari','ヒュッテ大槍','mountain_hut','kita_alps','yari_hotaka','enzanso',36.337867,137.655146,2884,'official','https://www.enzanso.co.jp/hutte-ooyari','https://www.enzanso.co.jp/hutte-ooyari','2026-09-13','verified'),
('sesshou_goya','殺生小屋','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.340347,137.652024,NULL,NULL,'https://www.yarigatake.co.jp/sesshou/','https://www.yarigatake.co.jp/sesshou/','2026-09-13','verified'),
('yarisawa_lodge','槍沢ロッヂ','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.318427,137.683953,NULL,NULL,'https://www.yarigatake.co.jp/yarisawa/','https://www.yarigatake.co.jp/yarisawa/','2026-09-13','verified'),
('minamidake_goya','南岳小屋','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.316560,137.649449,NULL,NULL,'https://www.yarigatake.co.jp/minamidake/','https://www.yarigatake.co.jp/minamidake/','2026-09-13','verified'),
('yokoo_sanso','横尾山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.292835,137.698888,1620,'official','https://www.yokoo-sanso.co.jp/','https://www.yokoo-sanso.co.jp/','2026-09-13','verified'),
('karasawa_hutte','涸沢ヒュッテ','mountain_hut','kita_alps','yari_hotaka','karasawa_h',36.294149,137.662667,NULL,NULL,'https://karasawa-hyutte.com/','https://karasawa-hyutte.com/inn','2026-09-13','verified'),
('karasawa_goya','涸沢小屋','mountain_hut','kita_alps','yari_hotaka','indep',36.294149,137.662667,2350,'official','https://karasawagoya.com/','https://karasawagoya.com/about/index.html','2026-09-13','verified'),
('kitahotaka_goya','北穂高小屋','mountain_hut','kita_alps','yari_hotaka','indep',36.303557,137.653912,3100,'official','https://www.kitaho.co.jp/','https://www.kitaho.co.jp/information','2026-09-13','verified'),
('hotakadake_sanso','穂高岳山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.293112,137.647475,2996,'official','https://www.hotakadakesanso.com/','https://www.hotakadakesanso.com/about/company','2026-09-13','verified'),
('nishiho_sanso','西穂山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.265989,137.617263,2367,'official','http://www.nishiho.com/','http://www.nishiho.com/about.htm','2026-09-13','verified'),
('dakesawa_goya','岳沢小屋','mountain_hut','kita_alps','kamikochi','yarigatake',36.278622,137.647113,NULL,NULL,'https://www.yarigatake.co.jp/dakesawa/','https://www.yarigatake.co.jp/dakesawa/','2026-09-13','verified'),
('tokusawaen','徳澤園','lodge','kita_alps','kamikochi','indep',36.265813,137.691010,1560,'gsi','https://www.tokusawaen.com/','https://www.tokusawaen.com/','2026-09-13','verified');

-- hut_seasons 2026 ------------------------------------------------
-- verified = 2026 年の営業期間を公式サイトで確認。reported = 公式に 2026 年の期間記載が無く二次情報のまま。
-- 予約 URL・電話・受付開始は公式サイトから転記（2026-09-13）。
INSERT INTO hut_seasons (hut_id,year,status,open_date,close_date,season_note,reservation_required,reservation_url,reservation_phone,booking_opens_at,capacity_beds,capacity_tents,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen',2026,'open','2026-04-25','2026-11-23',NULL,1,'https://www.hitou.or.jp/provider/plans?providerId=692','0263-77-1488','4〜6月分は4月1日 10:00から',NULL,20,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('ariakeso',2026,'open','2026-04-24','2026-11-03',NULL,1,'https://enzanso-reservation.jp/reserve/enz0010.php?p=40&type=20','0263-84-6511',NULL,NULL,NULL,'https://www.enzanso.co.jp/ariakeso','2026-09-13','verified'),
('enzanso',2026,'open','2026-04-25','2026-11-22','年末年始も営業',1,'https://enzanso-reservation.jp/reserve/enz0010.php?p=10&type=10','090-1420-0008','Web予約は前日まで。個室は4月1日から段階的に受付',650,45,'https://www.enzanso.co.jp/enzanso','2026-09-13','verified'),
('daitenso',2026,'open','2026-06-13','2026-11-03',NULL,1,'https://enzanso-reservation.jp/reserve/enz0010.php?p=20','090-9003-1253',NULL,150,50,'https://www.enzanso.co.jp/daitenso','2026-09-13','verified'),
('otenjo_hutte',2026,'open','2026-07-11','2026-10-11',NULL,1,'https://www.yarigatake.net/reservation/','090-1401-7884','宿泊日の1ヶ月前 朝9:00から',NULL,NULL,'https://www.yarigatake.co.jp/otenjo/','2026-09-13','verified'),
('hutte_nishidake',2026,'open','2026-07-10','2026-10-11',NULL,1,'https://enzanso-reservation.jp/reserve/enz0010.php?p=60','090-7172-2062',NULL,38,45,'https://www.enzanso.co.jp/hutte-nishidake','2026-09-13','verified'),
('jonen_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,'https://www.mt-jonen.com/reservation/','090-1430-3328','宿泊日の1ヶ月前（前月同日）から',186,70,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte',2026,'open','2026-04-25','2026-11-03',NULL,1,NULL,'090-1056-3455','4月1日 10:00から。5月14日以降の宿泊は6週前の同曜日 0:00から',150,30,'https://chougatake.com/stay/','2026-09-13','verified'),
('yarigatake_sanso',2026,'open','2026-04-27','2026-11-03',NULL,1,'https://www.yarigatake.net/reservation/','090-2641-1911','宿泊日の1ヶ月前 朝9:00から',NULL,40,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('hutte_ooyari',2026,'open','2026-07-01','2026-10-12',NULL,1,'https://enzanso-reservation.jp/reserve/enz0010.php?p=30','080-8728-8805','Web予約は当日 朝7:00まで',96,NULL,'https://www.enzanso.co.jp/hutte-ooyari','2026-09-13','verified'),
('sesshou_goya',2026,'open','2026-06-06','2026-10-11',NULL,1,'https://www.yarigatake.net/reservation/','080-8108-0361','宿泊日の1ヶ月前 朝9:00から',NULL,80,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarisawa_lodge',2026,'open','2026-04-27','2026-11-03',NULL,1,'https://www.yarigatake.net/reservation/','090-8250-2297','宿泊日の1ヶ月前 朝9:00から',NULL,60,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('minamidake_goya',2026,'open','2026-07-11','2026-10-11',NULL,1,'https://www.yarigatake.net/reservation/','090-4524-9448','宿泊日の1ヶ月前 朝9:00から',NULL,50,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yokoo_sanso',2026,'open','2026-04-27','2026-11-03','6月1日〜30日は修繕工事のため宿泊休業',1,'https://www.yokoo-sanso.co.jp/reservation','0263-95-2421','宿泊日の1ヶ月前 朝7:00から（電話）。7〜10月分はやまたんで2ヶ月前から限定数',150,150,'https://www.yokoo-sanso.co.jp/news/1793/','2026-09-13','verified'),
('karasawa_hutte',2026,'open','2026-04-27','2026-11-03','5月11日〜31日は改修工事のため休業',1,'https://www.yamatan.net/hut/karasawahutte','090-9002-2534','宿泊日の1ヶ月前の同日 朝8:00から',140,400,'https://karasawa-hyutte.com/inn','2026-09-13','verified'),
('karasawa_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,NULL,'090-2204-1300','宿泊日の1ヶ月前の同日から（5月25日までの分は4月25日から）',NULL,NULL,'https://karasawagoya.com/lodging/index.html','2026-09-13','verified'),
('kitahotaka_goya',2026,'open','2026-04-28','2026-11-03','テント場は6月中旬から',1,'https://www.yamatan.net/hut/kitahotakagoya','090-1422-8886','宿泊日の1ヶ月前（前月同日） 朝7:00から',NULL,20,'https://www.kitaho.co.jp/booking','2026-09-13','verified'),
('hotakadake_sanso',2026,'open','2026-04-27','2026-11-03',NULL,1,'https://www.hotakadakesanso.com/reservation','090-7869-0045','宿泊日の1ヶ月前 朝8:00から（Web）',210,60,'https://www.hotakadakesanso.com/stay/stay-guide','2026-09-13','verified'),
('nishiho_sanso',2026,'year_round',NULL,NULL,'通年営業',1,'https://select-type.com/rsv/?id=-TVMgpOH-fk','0263-36-7052','宿泊日の2ヶ月前の同日 9:30から（Web・電話とも）',NULL,30,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,'https://www.yarigatake.net/reservation/','090-2546-2100','宿泊日の1ヶ月前 朝9:00から',NULL,30,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('tokusawaen',2026,'open','2026-04-25','2026-11-03',NULL,1,'https://www.tokusawaen.com/reservation/','0263-95-2508','シーズン全日程を受付中（電話のみ）',NULL,200,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported');

-- hut_rates 2026 --------------------------------------------------
-- verified = 公式サイトの料金ページで確認。reported = 二次情報のまま。
INSERT INTO hut_rates (hut_id,year,plan_type,price_jpy,is_from_price,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen',2026,'two_meals',18850,1,'https://nakabusa.com/','2026-09-13','verified'),
('nakabusa_onsen',2026,'no_meal',10050,0,'https://nakabusa.com/','2026-09-13','verified'),
('nakabusa_onsen',2026,'tent',2500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('ariakeso',2026,'two_meals',16000,0,'https://www.enzanso.co.jp/ariakeso','2026-09-13','verified'),
('enzanso',2026,'two_meals',16000,0,'https://www.enzanso.co.jp/enzanso','2026-09-13','verified'),
('enzanso',2026,'no_meal',11000,0,'https://www.enzanso.co.jp/enzanso','2026-09-13','verified'),
('enzanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso',2026,'two_meals',16000,0,'https://www.enzanso.co.jp/daitenso','2026-09-13','verified'),
('daitenso',2026,'no_meal',11000,0,'https://www.enzanso.co.jp/daitenso','2026-09-13','verified'),
('daitenso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('otenjo_hutte',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/otenjo/special/','2026-09-13','verified'),
('otenjo_hutte',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/otenjo/special/','2026-09-13','verified'),
('hutte_nishidake',2026,'two_meals',16000,0,'https://www.enzanso.co.jp/hutte-nishidake','2026-09-13','verified'),
('hutte_nishidake',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya',2026,'two_meals',16000,0,'https://www.mt-jonen.com/charges/','2026-09-13','verified'),
('jonen_goya',2026,'no_meal',11000,0,'https://www.mt-jonen.com/charges/','2026-09-13','verified'),
('jonen_goya',2026,'tent',2000,0,'https://www.mt-jonen.com/charges/','2026-09-13','verified'),
('chougatake_hutte',2026,'two_meals',16000,0,'https://chougatake.com/stay/','2026-09-13','verified'),
('chougatake_hutte',2026,'no_meal',11000,0,'https://chougatake.com/stay/','2026-09-13','verified'),
('chougatake_hutte',2026,'tent',2000,0,'https://chougatake.com/stay/','2026-09-13','verified'),
('yarigatake_sanso',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarigatake_sanso',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarigatake_sanso',2026,'tent',2000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('hutte_ooyari',2026,'two_meals',16000,0,'https://www.enzanso.co.jp/hutte-ooyari','2026-09-13','verified'),
('hutte_ooyari',2026,'no_meal',11000,0,'https://www.enzanso.co.jp/hutte-ooyari','2026-09-13','verified'),
('sesshou_goya',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('sesshou_goya',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('sesshou_goya',2026,'tent',2000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarisawa_lodge',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarisawa_lodge',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yarisawa_lodge',2026,'tent',2000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('minamidake_goya',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('minamidake_goya',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('minamidake_goya',2026,'tent',2000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('yokoo_sanso',2026,'two_meals',15600,0,'https://www.yokoo-sanso.co.jp/information','2026-09-13','verified'),
('yokoo_sanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte',2026,'two_meals',16000,0,'https://karasawa-hyutte.com/inn','2026-09-13','verified'),
('karasawa_hutte',2026,'no_meal',11000,0,'https://karasawa-hyutte.com/inn','2026-09-13','verified'),
('karasawa_hutte',2026,'tent',2000,0,'https://karasawa-hyutte.com/inn','2026-09-13','verified'),
('karasawa_goya',2026,'two_meals',16000,0,'https://karasawagoya.com/lodging/index.html','2026-09-13','verified'),
('karasawa_goya',2026,'no_meal',9800,0,'https://karasawagoya.com/lodging/index.html','2026-09-13','verified'),
('kitahotaka_goya',2026,'two_meals',15500,0,'https://www.kitaho.co.jp/booking','2026-09-13','verified'),
('kitahotaka_goya',2026,'no_meal',11000,0,'https://www.kitaho.co.jp/booking','2026-09-13','verified'),
('kitahotaka_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso',2026,'two_meals',15500,0,'https://www.hotakadakesanso.com/stay/stay-guide','2026-09-13','verified'),
('hotakadake_sanso',2026,'no_meal',11000,0,'https://www.hotakadakesanso.com/stay/stay-guide','2026-09-13','verified'),
('hotakadake_sanso',2026,'tent',2000,0,'https://www.hotakadakesanso.com/stay/stay-guide','2026-09-13','verified'),
('nishiho_sanso',2026,'two_meals',15500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'two_meals',16000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('dakesawa_goya',2026,'no_meal',11200,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('dakesawa_goya',2026,'tent',2000,0,'https://www.yarigatake.co.jp/lodge/','2026-09-13','verified'),
('tokusawaen',2026,'two_meals',17600,1,'https://www.tokusawaen.com/reservation/','2026-09-13','verified'),
('tokusawaen',2026,'no_meal',11000,0,'https://www.tokusawaen.com/reservation/','2026-09-13','verified'),
('tokusawaen',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported');

-- facilities -------------------------------------------------------
-- 全21軒の枠を作り、公式サイトで読み取れた項目だけ埋める。不明は NULL のまま（推測しない）。
-- toilet_type: 'composting' = バイオトイレ / 'portable' = カートリッジ式（ヘリで便槽搬出） / 'flush' = 簡易水洗含む
INSERT INTO hut_facilities (hut_id, confidence)
  SELECT id, 'unknown' FROM huts;

UPDATE hut_facilities SET water_available='paid', charging_service=0, cash_only=1, credit_card=0,
  source_url='https://www.enzanso.co.jp/enzanso', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='enzanso';
UPDATE hut_facilities SET water_available='free', charging_service=1, cash_only=1, credit_card=0,
  source_url='https://www.enzanso.co.jp/daitenso', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='daitenso';
UPDATE hut_facilities SET toilet_type='portable', charging_service=1,
  source_url='https://www.yarigatake.co.jp/otenjo/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='otenjo_hutte';
UPDATE hut_facilities SET water_available='paid', charging_service=0, cash_only=1, credit_card=0,
  source_url='https://www.enzanso.co.jp/hutte-nishidake', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='hutte_nishidake';
UPDATE hut_facilities SET drying_room=1, shop=1,
  source_url='http://www.mt-jonen.com/about/facility/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='jonen_goya';
UPDATE hut_facilities SET water_available='paid', charging_service=1, charging_fee_jpy=200, cash_only=1, credit_card=0,
  source_url='https://chougatake.com/stay/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='chougatake_hutte';
UPDATE hut_facilities SET toilet_type='composting', water_available='paid', charging_service=1, charging_fee_jpy=100,
  source_url='https://www.yarigatake.co.jp/yarigatake/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='yarigatake_sanso';
UPDATE hut_facilities SET charging_service=0, cash_only=1, credit_card=0,
  source_url='https://www.enzanso.co.jp/hutte-ooyari', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='hutte_ooyari';
UPDATE hut_facilities SET toilet_type='composting', water_available='free', charging_service=1, charging_fee_jpy=100,
  source_url='https://www.yarigatake.co.jp/yarisawa/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='yarisawa_lodge';
UPDATE hut_facilities SET toilet_type='composting', water_available='free', charging_service=1, charging_fee_jpy=100,
  source_url='https://www.yarigatake.co.jp/minamidake/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='minamidake_goya';
UPDATE hut_facilities SET power_outlet=1, charging_service=1, bath=1, credit_card=1,
  source_url='https://www.yokoo-sanso.co.jp/information', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='yokoo_sanso';
UPDATE hut_facilities SET toilet_fee_jpy=100, water_available='free',
  source_url='https://karasawa-hyutte.com/inn', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='karasawa_hutte';
UPDATE hut_facilities SET toilet_type='composting', shop=1,
  source_url='https://karasawagoya.com/facility/index.html', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='karasawa_goya';
UPDATE hut_facilities SET water_available='free',
  source_url='https://www.kitaho.co.jp/booking', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='kitahotaka_goya';
UPDATE hut_facilities SET toilet_type='flush', water_available='free', credit_card=1,
  source_url='https://www.hotakadakesanso.com/stay/facility', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='hotakadake_sanso';
UPDATE hut_facilities SET toilet_type='portable', water_available='free', charging_service=1,
  source_url='https://www.yarigatake.co.jp/dakesawa/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='dakesawa_goya';
UPDATE hut_facilities SET bath=1, credit_card=0, qr_payment=1,
  source_url='https://www.tokusawaen.com/faq/', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='tokusawaen';
UPDATE hut_facilities SET water_available='free', charging_service=0,
  source_url='https://www.enzanso.co.jp/ariakeso', last_verified_at='2026-09-13', confidence='verified' WHERE hut_id='ariakeso';

-- 電波（公式サイト記載分のみ）
INSERT INTO hut_mobile_signal (hut_id,carrier,quality,source_url,last_verified_at,confidence) VALUES
('minamidake_goya','docomo','good','https://www.yarigatake.co.jp/minamidake/','2026-09-13','verified'),
('minamidake_goya','au','good','https://www.yarigatake.co.jp/minamidake/','2026-09-13','verified'),
('minamidake_goya','softbank','spotty','https://www.yarigatake.co.jp/minamidake/','2026-09-13','verified');

-- trailheads / access ---------------------------------------------
INSERT INTO trailheads (id,name_ja,lat,lon,elevation_m,parking_spaces,parking_note) VALUES
('nakabusa','中房温泉登山口',36.390663,137.749111,1462,NULL,'第1〜第3駐車場。ハイシーズンは早朝満車'),
('kamikochi','上高地',36.250485,137.631509,1500,0,'通年マイカー規制。沢渡・平湯からバス/タクシー'),
('shin_hotaka','新穂高',36.291175,137.594088,1100,NULL,NULL);

INSERT INTO access_routes (id,trailhead_id,mode,operator_name,from_place,seasonal_only,requires_hut_stay,reservation_required,private_car_restricted,source_url,confidence) VALUES
('nakabusa_bus','nakabusa','bus','南安タクシー（乗合バス）','穂高駅',1,0,0,0,NULL,'unknown'),
('kamikochi_bus','kamikochi','bus','アルピコ交通','沢渡・平湯',1,0,0,1,NULL,'unknown'),
('kamikochi_taxi','kamikochi','taxi',NULL,'沢渡・平湯',0,0,0,1,NULL,'unknown'),
('shinhotaka_ropeway','shin_hotaka','ropeway','奥飛騨観光開発','新穂高温泉',0,0,0,0,NULL,'unknown');

INSERT INTO hut_trailheads (hut_id,trailhead_id,walk_time_up_min) VALUES
('enzanso','nakabusa',300),
('nishiho_sanso','shin_hotaka',90),
('tokusawaen','kamikochi',120),
('dakesawa_goya','kamikochi',150),
('yokoo_sanso','kamikochi',180);

-- trails ----------------------------------------------------------
INSERT INTO trails (id,name_ja,nights_typical,difficulty,summary) VALUES
('omote_ginza','表銀座縦走（中房温泉→槍ヶ岳）',2,'hard','燕岳から大天井、東鎌尾根を経て槍ヶ岳へ抜ける北アルプス王道の縦走路'),
('karasawa_base','涸沢ベース 穂高周遊',2,'moderate','上高地から涸沢に入り、北穂高・奥穂高を回って涸沢に戻る');

-- trail_stops
--   hut_id / trailhead_id が両方 NULL の行 = 通過点（ピーク・乗越）。label と elevation_m を持つ。
--   通過点の標高の出典: 槍ヶ岳3180 (yarigatake.co.jp) / 北穂高岳3106・涸沢カール2300 (kitaho.co.jp/about) /
--   奥穂高岳3190 (hotakadakesanso.com) / 赤岩岳2769・水俣乗越2474 (国土地理院 地名検索座標の標高API)
--   通過点の cumulative_time_min は前後の小屋間コースタイムを按分した概算で、断面図の形を出すためのもの。
INSERT INTO trail_stops (trail_id,seq,hut_id,trailhead_id,cumulative_time_min,is_overnight_candidate,label,elevation_m) VALUES
('omote_ginza', 1,NULL,'nakabusa',      0,0,NULL,NULL),
('omote_ginza', 2,'enzanso',NULL,     300,1,NULL,NULL),
('omote_ginza', 3,'daitenso',NULL,    540,1,NULL,NULL),
('omote_ginza', 4,'otenjo_hutte',NULL,570,1,NULL,NULL),
('omote_ginza', 5,NULL,NULL,          640,0,'赤岩岳',2769),
('omote_ginza', 6,'hutte_nishidake',NULL,690,1,NULL,NULL),
('omote_ginza', 7,NULL,NULL,          730,0,'水俣乗越',2474),
('omote_ginza', 8,'hutte_ooyari',NULL,780,1,NULL,NULL),
('omote_ginza', 9,'yarigatake_sanso',NULL,840,1,NULL,NULL),
('omote_ginza',10,NULL,NULL,          870,0,'槍ヶ岳',3180),
('karasawa_base', 1,NULL,'kamikochi',     0,0,NULL,NULL),
('karasawa_base', 2,'tokusawaen',NULL,  120,1,NULL,NULL),
('karasawa_base', 3,'yokoo_sanso',NULL, 180,1,NULL,NULL),
('karasawa_base', 4,'karasawa_hutte',NULL,360,1,NULL,NULL),
('karasawa_base', 5,'karasawa_goya',NULL, 370,1,NULL,NULL),
('karasawa_base', 6,'kitahotaka_goya',NULL,540,1,NULL,NULL),
('karasawa_base', 7,NULL,NULL,          550,0,'北穂高岳',3106),
('karasawa_base', 8,NULL,NULL,          670,0,'涸沢カール',2300),
('karasawa_base', 9,'hotakadake_sanso',NULL,850,1,NULL,NULL),
('karasawa_base',10,NULL,NULL,          900,0,'奥穂高岳',3190);

-- photos ---------------------------------------------------------
-- 全て運営者撮影。位置情報などの EXIF は static/img へ書き出す時に除去済み。
INSERT INTO photos (id,file,alt,caption,credit,role,hut_id,trail_id,range_id,taken_on,sort) VALUES
('hero_sunrise','omote-tents-sunrise','稜線のテント場に朝日が差し、雲海が広がっている','稜線のテント場で迎える朝。ここに泊まるために歩く。','撮影：HutsGo','hero',NULL,NULL,'kita_alps','2026-07-19',0),
('omote_tsubakuro','omote-tsubakuro','白い花崗岩の燕岳の稜線と、緑の斜面にかかる雲','燕岳。燕山荘のすぐ北、花崗岩の白い稜線。','撮影：HutsGo','trail','enzanso','omote_ginza','kita_alps','2026-07-18',0),
('omote_tents_dawn','omote-tents-dawn','夜明け前の稜線に色とりどりのテントが並ぶ','夜明け前のテント場。雲海の上で目を覚ます。','撮影：HutsGo','trail',NULL,'omote_ginza','kita_alps','2026-07-19',1),
('ridge_hut_clouds','ridge-hut-clouds','雲の湧く稜線の鞍部に建つ山小屋','雲の湧く稜線と、鞍部の山小屋。','撮影：HutsGo','area',NULL,NULL,'kita_alps',NULL,0),
('dolomiti_trecime','dolomiti-trecime','夕日に染まるトレ・チーメ・ディ・ラヴァレードの岩峰','Tre Cime di Lavaredo。夕方、岩壁だけが赤く残る。','撮影：HutsGo','teaser',NULL,NULL,'dolomites',NULL,0),
('dolomiti_locatelli','dolomiti-locatelli','岩峰に囲まれた赤い屋根の山小屋 Rifugio Locatelli','Rifugio Locatelli（Dreizinnenhütte）。ドロミティの山小屋は昼から賑わう。','撮影：HutsGo','teaser',NULL,NULL,'dolomites',NULL,1),
('dolomiti_pano','dolomiti-pano','ドロミティの岩の稜線から見下ろす谷と遠くの山群','ドロミティの稜線から。谷ごとに小屋があり、線でつなげる。','撮影：HutsGo','teaser',NULL,NULL,'dolomites',NULL,2);

-- ---------------------------------------------------------------
-- 英語版のためのデータ（訪日ハイカー向け）
--   小屋名はローマ字。画面では「Enzanso (燕山荘)」と日本語を併記して出す。
--   現地で小屋の人やバス運転手に見せる必要があるため、日本語を落とさないこと。
--   booking_opens_at_en は英語版の中核。電話が使えない相手に「いつ受付が開くか」を伝える。
-- ---------------------------------------------------------------
UPDATE operators SET name_en='Enzanso Group'          WHERE id='enzanso';
UPDATE operators SET name_en='Yarigatake Sanso Group' WHERE id='yarigatake';
UPDATE operators SET name_en='Chogatake Hutte'        WHERE id='chougatake';
UPDATE operators SET name_en='Karasawa Hutte'         WHERE id='karasawa_h';
UPDATE operators SET name_en='Independent'            WHERE id='indep';

UPDATE huts SET name_en='Nakabusa Onsen'    WHERE id='nakabusa_onsen';
UPDATE huts SET name_en='Ariakeso'          WHERE id='ariakeso';
UPDATE huts SET name_en='Enzanso'           WHERE id='enzanso';
UPDATE huts SET name_en='Daitenso'          WHERE id='daitenso';
UPDATE huts SET name_en='Otensho Hutte'     WHERE id='otenjo_hutte';
UPDATE huts SET name_en='Hutte Nishidake'   WHERE id='hutte_nishidake';
UPDATE huts SET name_en='Jonen-goya'        WHERE id='jonen_goya';
UPDATE huts SET name_en='Chogatake Hutte'   WHERE id='chougatake_hutte';
UPDATE huts SET name_en='Yarigatake Sanso'  WHERE id='yarigatake_sanso';
UPDATE huts SET name_en='Hutte Oyari'       WHERE id='hutte_ooyari';
UPDATE huts SET name_en='Sessho-goya'       WHERE id='sesshou_goya';
UPDATE huts SET name_en='Yarisawa Lodge'    WHERE id='yarisawa_lodge';
UPDATE huts SET name_en='Minamidake-goya'   WHERE id='minamidake_goya';
UPDATE huts SET name_en='Yokoo Sanso'       WHERE id='yokoo_sanso';
UPDATE huts SET name_en='Karasawa Hutte'    WHERE id='karasawa_hutte';
UPDATE huts SET name_en='Karasawa-goya'     WHERE id='karasawa_goya';
UPDATE huts SET name_en='Kitahotaka-goya'   WHERE id='kitahotaka_goya';
UPDATE huts SET name_en='Hotakadake Sanso'  WHERE id='hotakadake_sanso';
UPDATE huts SET name_en='Nishiho Sanso'     WHERE id='nishiho_sanso';
UPDATE huts SET name_en='Dakesawa-goya'     WHERE id='dakesawa_goya';
UPDATE huts SET name_en='Tokusawaen'        WHERE id='tokusawaen';

UPDATE trailheads SET name_en='Nakabusa Onsen trailhead',
  parking_note_en='Three car parks. Full from early morning in peak season.' WHERE id='nakabusa';
UPDATE trailheads SET name_en='Kamikochi',
  parking_note_en='Closed to private cars all year. Bus or taxi from Sawando or Hirayu.' WHERE id='kamikochi';
UPDATE trailheads SET name_en='Shin-Hotaka' WHERE id='shin_hotaka';

UPDATE trails SET name_en='Omote-Ginza Traverse (Nakabusa Onsen to Yarigatake)',
  summary_en='The classic Northern Alps ridge line: up to Tsubakuro-dake, along to Daitenjo, then the Higashi-Kama ridge to the spire of Yarigatake.'
  WHERE id='omote_ginza';
UPDATE trails SET name_en='Karasawa Base: the Hotaka circuit',
  summary_en='Walk in from Kamikochi to the Karasawa cirque, then round Kita-Hotaka and Oku-Hotaka and back down.'
  WHERE id='karasawa_base';

UPDATE trail_stops SET label_en='Akaiwa-dake'      WHERE label='赤岩岳';
UPDATE trail_stops SET label_en='Suimata-nokkoshi' WHERE label='水俣乗越';
UPDATE trail_stops SET label_en='Yarigatake'       WHERE label='槍ヶ岳';
UPDATE trail_stops SET label_en='Kita-Hotaka'      WHERE label='北穂高岳';
UPDATE trail_stops SET label_en='Karasawa cirque'  WHERE label='涸沢カール';
UPDATE trail_stops SET label_en='Oku-Hotaka'       WHERE label='奥穂高岳';

UPDATE hut_seasons SET season_note_en='Also open over the New Year period' WHERE hut_id='enzanso' AND year=2026;
UPDATE hut_seasons SET season_note_en='Closed for repairs 1-30 June' WHERE hut_id='yokoo_sanso' AND year=2026;
UPDATE hut_seasons SET season_note_en='Closed for refurbishment 11-31 May' WHERE hut_id='karasawa_hutte' AND year=2026;
UPDATE hut_seasons SET season_note_en='Campsite opens from mid June' WHERE hut_id='kitahotaka_goya' AND year=2026;
UPDATE hut_seasons SET season_note_en='Open all year' WHERE hut_id='nishiho_sanso' AND year=2026;

-- 予約受付開始（英語版の中核。時刻はすべて日本時間）
UPDATE hut_seasons SET booking_opens_at_en='1 April, 10:00 JST, for April-June stays' WHERE hut_id='nakabusa_onsen' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='Online booking closes the day before. Private rooms open in stages from 1 April.' WHERE hut_id='enzanso' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='otenjo_hutte' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay (same date, previous month)' WHERE hut_id='jonen_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='1 April, 10:00 JST. From 14 May, six weeks ahead on the same weekday, 00:00 JST.' WHERE hut_id='chougatake_hutte' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='yarigatake_sanso' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='Online booking closes at 07:00 JST on the day' WHERE hut_id='hutte_ooyari' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='sesshou_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='yarisawa_lodge' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='minamidake_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 07:00 JST, by phone. For 1 July - 25 Oct a limited number opens two months ahead via Yamatan.' WHERE hut_id='yokoo_sanso' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay (same date), 08:00 JST' WHERE hut_id='karasawa_hutte' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay (same date). Stays up to 25 May open on 25 April.' WHERE hut_id='karasawa_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay (same date, previous month), 07:00 JST' WHERE hut_id='kitahotaka_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 08:00 JST, online' WHERE hut_id='hotakadake_sanso' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='Two months before your stay (same date), 09:30 JST, online or by phone' WHERE hut_id='nishiho_sanso' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='One month before your stay, 09:00 JST' WHERE hut_id='dakesawa_goya' AND year=2026;
UPDATE hut_seasons SET booking_opens_at_en='Taking bookings for the whole season now, by phone only' WHERE hut_id='tokusawaen' AND year=2026;

UPDATE photos SET alt_en='Tents on a ridge at sunrise above a sea of cloud',
  caption_en='Morning on the ridge campsite. This is what you walk up for.' WHERE id='hero_sunrise';
UPDATE photos SET alt_en='The white granite ridge of Tsubakuro-dake with cloud on the green slopes',
  caption_en='Tsubakuro-dake, just north of Enzanso, on white granite.' WHERE id='omote_tsubakuro';
UPDATE photos SET alt_en='Colourful tents on the ridge before dawn',
  caption_en='The campsite before dawn. You wake above the clouds.' WHERE id='omote_tents_dawn';
UPDATE photos SET alt_en='A mountain hut on a saddle with cloud building along the ridge',
  caption_en='Cloud rising along the ridge, and a hut on the saddle.' WHERE id='ridge_hut_clouds';
UPDATE photos SET alt_en='The towers of Tre Cime di Lavaredo lit red at sunset',
  caption_en='Tre Cime di Lavaredo. At dusk only the walls stay lit.' WHERE id='dolomiti_trecime';
UPDATE photos SET alt_en='Rifugio Locatelli, a red-roofed hut ringed by rock towers',
  caption_en='Rifugio Locatelli (Dreizinnenhuette). Dolomite huts are busy from midday.' WHERE id='dolomiti_locatelli';
UPDATE photos SET alt_en='A valley and distant peaks seen from a rocky Dolomite ridge',
  caption_en='From a Dolomite ridge. A hut in every valley, waiting to be joined up.' WHERE id='dolomiti_pano';

-- アクセスの英語表記。駅名・バス会社名は現地で探す必要があるので日本語も残す
UPDATE access_routes SET operator_name_en='Nan-an Taxi (shared bus) 南安タクシー', from_place_en='Hotaka Station 穂高駅' WHERE id='nakabusa_bus';
UPDATE access_routes SET operator_name_en='Alpico Kotsu アルピコ交通', from_place_en='Sawando or Hirayu 沢渡・平湯' WHERE id='kamikochi_bus';
UPDATE access_routes SET from_place_en='Sawando or Hirayu 沢渡・平湯' WHERE id='kamikochi_taxi';
UPDATE access_routes SET operator_name_en='Okuhida Kanko Kaihatsu 奥飛騨観光開発', from_place_en='Shin-Hotaka Onsen 新穂高温泉' WHERE id='shinhotaka_ropeway';

COMMIT;

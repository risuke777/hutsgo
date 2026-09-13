-- HutsGo PoC seed: 表銀座 → 槍 → 穂高 の縦走ライン 21軒
--
-- IMPORTANT / データの出自について
--   season / rate は二次情報（山と溪谷オンライン 2026年版一覧）由来のため
--   confidence='reported' で登録している。公開前に各小屋の公式サイトで
--   再検証し 'verified' + last_verified_at 更新 が必須。
--   facilities は構造化された公開情報が存在しないため意図的に NULL。
--   → これが HutsGo の埋めるべき空白そのもの。
--
-- 座標は山域単位の概略値。実測 or 地理院データで置換予定。

BEGIN;

INSERT INTO mountain_ranges (id, name_ja, name_en) VALUES
  ('kita_alps', '北アルプス', 'Northern Japan Alps');

INSERT INTO sub_areas (id, range_id, name_ja, name_en) VALUES
  ('omote_ginza',  'kita_alps', '表銀座・常念山脈', 'Omote-Ginza'),
  ('yari_hotaka',  'kita_alps', '槍ヶ岳・穂高連峰', 'Yari-Hotaka'),
  ('kamikochi',    'kita_alps', '上高地',           'Kamikochi');

INSERT INTO operators (id, name_ja, website, booking_system) VALUES
  ('enzanso',   '燕山荘グループ',   'https://www.enzanso.co.jp/',     'enzanso-reservation.jp'),
  ('yarigatake','槍ヶ岳山荘グループ','https://www.yarigatake.co.jp/',  NULL),
  ('chougatake','蝶ヶ岳ヒュッテ',   'https://chougatake.com/',        NULL),
  ('karasawa_h','涸沢ヒュッテ',     'https://karasawa-hyutte.com/',   NULL),
  ('indep',     '独立運営',         NULL,                             NULL);

-- huts -----------------------------------------------------------
INSERT INTO huts (id,name_ja,hut_type,range_id,sub_area_id,operator_id,lat,lon,official_url,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen','中房温泉','onsen','kita_alps','omote_ginza','indep',36.390663,137.749111,'https://nakabusa.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('ariakeso','有明荘','lodge','kita_alps','omote_ginza','enzanso',36.390663,137.749111,'https://www.enzanso.co.jp/ariakeso','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('enzanso','燕山荘','mountain_hut','kita_alps','omote_ginza','enzanso',36.399506,137.715208,'https://www.enzanso.co.jp/enzanso','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso','大天荘','mountain_hut','kita_alps','omote_ginza','enzanso',36.365025,137.700359,'https://www.enzanso.co.jp/daitenso','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('otenjo_hutte','大天井ヒュッテ','mountain_hut','kita_alps','omote_ginza','yarigatake',36.365025,137.700359,'https://www.yarigatake.co.jp/otenjo/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake','ヒュッテ西岳','mountain_hut','kita_alps','omote_ginza','enzanso',36.335991,137.680017,'https://www.enzanso.co.jp/hutte-nishidake','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya','常念小屋','mountain_hut','kita_alps','omote_ginza','indep',36.333571,137.727567,'http://www.mt-jonen.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte','蝶ヶ岳ヒュッテ','mountain_hut','kita_alps','omote_ginza','chougatake',36.287923,137.724907,'https://chougatake.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarigatake_sanso','槍ヶ岳山荘','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.340347,137.652024,'https://www.yarigatake.co.jp/yarigatake/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_ooyari','ヒュッテ大槍','mountain_hut','kita_alps','yari_hotaka','enzanso',36.340347,137.652024,'https://www.enzanso.co.jp/hutte-ooyari','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('sesshou_goya','殺生小屋','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.340347,137.652024,'https://www.yarigatake.co.jp/sesshou/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarisawa_lodge','槍沢ロッヂ','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.318427,137.683953,'https://www.yarigatake.co.jp/yarisawa/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('minamidake_goya','南岳小屋','mountain_hut','kita_alps','yari_hotaka','yarigatake',36.316560,137.649449,'https://www.yarigatake.co.jp/minamidake/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso','横尾山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.292835,137.698888,'https://www.yokoo-sanso.co.jp/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte','涸沢ヒュッテ','mountain_hut','kita_alps','yari_hotaka','karasawa_h',36.294149,137.662667,'https://karasawa-hyutte.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_goya','涸沢小屋','mountain_hut','kita_alps','yari_hotaka','indep',36.294149,137.662667,'https://karasawagoya.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('kitahotaka_goya','北穂高小屋','mountain_hut','kita_alps','yari_hotaka','indep',36.303557,137.653912,'https://www.kitaho.co.jp/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso','穂高岳山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.293112,137.647475,'https://www.hotakadakesanso.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso','西穂山荘','mountain_hut','kita_alps','yari_hotaka','indep',36.265989,137.617263,'http://www.nishiho.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya','岳沢小屋','mountain_hut','kita_alps','kamikochi','yarigatake',36.276371,137.646102,'https://www.yarigatake.co.jp/dakesawa/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('tokusawaen','徳澤園','lodge','kita_alps','kamikochi','indep',36.264258,137.690390,'https://www.tokusawaen.com/','https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported');

-- hut_seasons 2026 ------------------------------------------------
INSERT INTO hut_seasons (hut_id,year,status,open_date,close_date,season_note,reservation_required,capacity_tents,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen',2026,'open','2026-04-25','2026-11-23',NULL,1,20,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('ariakeso',2026,'open','2026-04-24','2026-11-04',NULL,1,NULL,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('enzanso',2026,'open','2026-04-25','2026-11-22','年末年始も営業',1,45,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso',2026,'open','2026-06-13','2026-11-03',NULL,1,50,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('otenjo_hutte',2026,'open','2026-07-11','2026-10-11',NULL,1,NULL,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake',2026,'open','2026-07-10','2026-10-11',NULL,1,45,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,70,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte',2026,'open','2026-04-25','2026-11-03',NULL,1,30,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarigatake_sanso',2026,'open','2026-04-27','2026-11-03',NULL,1,40,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_ooyari',2026,'open','2026-07-01','2026-10-12',NULL,1,NULL,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('sesshou_goya',2026,'open','2026-06-06','2026-10-11',NULL,1,80,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarisawa_lodge',2026,'open','2026-04-27','2026-11-03',NULL,1,60,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('minamidake_goya',2026,'open','2026-07-11','2026-10-11',NULL,1,50,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso',2026,'open','2026-04-27','2026-11-03','6月はテント場と売店のみ',1,150,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte',2026,'open','2026-04-27','2026-11-03',NULL,1,400,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,NULL,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('kitahotaka_goya',2026,'open','2026-04-28','2026-11-03','テント場は6月中旬から',1,20,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso',2026,'open','2026-04-27','2026-11-03',NULL,1,60,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'year_round',NULL,NULL,'通年営業',1,30,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'open','2026-04-27','2026-11-03',NULL,1,30,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('tokusawaen',2026,'open','2026-04-25','2026-11-03',NULL,1,200,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported');

-- hut_rates 2026 --------------------------------------------------
INSERT INTO hut_rates (hut_id,year,plan_type,price_jpy,is_from_price,source_url,last_verified_at,confidence) VALUES
('nakabusa_onsen',2026,'two_meals',15000,1,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nakabusa_onsen',2026,'no_meal',10050,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nakabusa_onsen',2026,'tent',2500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('ariakeso',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('enzanso',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('enzanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('enzanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('daitenso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('otenjo_hutte',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('otenjo_hutte',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_nishidake',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('jonen_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('chougatake_hutte',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarigatake_sanso',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarigatake_sanso',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarigatake_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_ooyari',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hutte_ooyari',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('sesshou_goya',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('sesshou_goya',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('sesshou_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarisawa_lodge',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarisawa_lodge',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yarisawa_lodge',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('minamidake_goya',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('minamidake_goya',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('minamidake_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso',2026,'two_meals',15600,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('yokoo_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte',2026,'two_meals',16000,1,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte',2026,'no_meal',11000,1,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_hutte',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_goya',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('karasawa_goya',2026,'no_meal',9800,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('kitahotaka_goya',2026,'two_meals',15500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('kitahotaka_goya',2026,'no_meal',10500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('kitahotaka_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso',2026,'two_meals',15500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('hotakadake_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'two_meals',15500,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('nishiho_sanso',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'two_meals',16000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'no_meal',11200,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('dakesawa_goya',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('tokusawaen',2026,'two_meals',17600,1,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('tokusawaen',2026,'no_meal',11000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported'),
('tokusawaen',2026,'tent',2000,0,'https://www.yamakei-online.com/yama-ya/detail.php?id=2535','2026-09-13','reported');

-- facilities: 意図的に空。ここを埋めるのが HutsGo の仕事。
-- 全21軒の枠だけ作り confidence='unknown' で「未取材」を可視化する。
INSERT INTO hut_facilities (hut_id, confidence)
  SELECT id, 'unknown' FROM huts;

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
('karasawa_base','涸沢ベース 穂高周遊',2,'moderate','上高地から涸沢に入り、北穂・奥穂を日帰りピストンする');

INSERT INTO trail_stops (trail_id,seq,hut_id,trailhead_id,cumulative_time_min,is_overnight_candidate) VALUES
('omote_ginza',1,NULL,'nakabusa',0,0),
('omote_ginza',2,'enzanso',NULL,300,1),
('omote_ginza',3,'daitenso',NULL,540,1),
('omote_ginza',4,'otenjo_hutte',NULL,570,1),
('omote_ginza',5,'hutte_ooyari',NULL,780,1),
('omote_ginza',6,'yarigatake_sanso',NULL,840,1),
('karasawa_base',1,NULL,'kamikochi',0,0),
('karasawa_base',2,'tokusawaen',NULL,120,1),
('karasawa_base',3,'yokoo_sanso',NULL,180,1),
('karasawa_base',4,'karasawa_hutte',NULL,360,1),
('karasawa_base',5,'karasawa_goya',NULL,370,1),
('karasawa_base',6,'kitahotaka_goya',NULL,540,1),
('karasawa_base',7,'hotakadake_sanso',NULL,540,1);

COMMIT;

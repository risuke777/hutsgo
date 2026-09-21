-- HutsGo PoC schema
-- SQLite for local PoC. Postgres migration notes inline (-- PG:).
-- Design rule: every fact-bearing row carries source_url + last_verified_at + confidence.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- Master
-- ---------------------------------------------------------------
CREATE TABLE mountain_ranges (
  id            TEXT PRIMARY KEY,      -- 'kita_alps'
  name_ja       TEXT NOT NULL,
  name_en       TEXT
);

CREATE TABLE sub_areas (
  id            TEXT PRIMARY KEY,      -- 'omote_ginza'
  range_id      TEXT NOT NULL REFERENCES mountain_ranges(id),
  name_ja       TEXT NOT NULL,
  name_en       TEXT
);

CREATE TABLE operators (
  id            TEXT PRIMARY KEY,      -- 'enzanso_group'
  name_ja       TEXT NOT NULL,
  name_en       TEXT,
  website       TEXT,
  -- one operator often runs many huts with a shared booking system.
  -- this is the unit you negotiate an API deal with, not the hut.
  booking_system TEXT                  -- 'enzanso-reservation.jp' etc.
);

CREATE TABLE huts (
  id             TEXT PRIMARY KEY,     -- slug. never renumber.
  name_ja        TEXT NOT NULL,
  name_en        TEXT,
  name_kana      TEXT,
  hut_type       TEXT NOT NULL CHECK (hut_type IN
                   ('mountain_hut','emergency_hut','campsite','lodge','hotel','onsen')),
  range_id       TEXT REFERENCES mountain_ranges(id),
  sub_area_id    TEXT REFERENCES sub_areas(id),
  operator_id    TEXT REFERENCES operators(id),
  lat            REAL,
  lon            REAL,
  elevation_m    INTEGER,
  -- 'official' = 小屋の公式サイト記載値 / 'gsi' = 国土地理院 標高API（平地の宿のみ。稜線の小屋は位置誤差が大きいので使わない）
  elevation_source TEXT CHECK (elevation_source IN ('official','gsi')),
  official_url   TEXT,
  source_url     TEXT,
  last_verified_at TEXT,
  confidence     TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (confidence IN ('verified','reported','unknown'))
);
-- PG: add  geog geography(Point,4326)  + GIST index for radius search.

-- ---------------------------------------------------------------
-- Time-varying: season / rates. Split from huts on purpose.
-- Hut data is a yearly time series; burying it in huts destroys history.
-- ---------------------------------------------------------------
CREATE TABLE hut_seasons (
  hut_id         TEXT NOT NULL REFERENCES huts(id),
  year           INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('open','closed_this_year','undecided','year_round')),
  open_date      TEXT,                 -- ISO. NULL when status<>'open'
  close_date     TEXT,
  season_note    TEXT,                 -- '年末年始も営業' 等、非連続営業の注記
  season_note_en TEXT,
  reservation_required INTEGER,        -- 0/1/NULL
  reservation_url TEXT,
  reservation_phone TEXT,
  booking_opens_at TEXT,               -- 予約解禁日時。競争の激しい小屋で価値が高い
  -- 英語版の中核。訪日ハイカーは電話が使えず、受付開始を逃すと泊まれない
  booking_opens_at_en TEXT,
  capacity_beds  INTEGER,
  capacity_tents INTEGER,
  source_url     TEXT,
  last_verified_at TEXT,
  confidence     TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (confidence IN ('verified','reported','unknown')),
  PRIMARY KEY (hut_id, year)
);

CREATE TABLE hut_rates (
  hut_id         TEXT NOT NULL REFERENCES huts(id),
  year           INTEGER NOT NULL,
  plan_type      TEXT NOT NULL CHECK (plan_type IN
                   ('two_meals','one_meal','no_meal','tent','private_room','day_use')),
  price_jpy      INTEGER,               -- 名前は歴史的経緯。currency が 'EUR' なら EUR の額（ドロミティ用）
  currency       TEXT NOT NULL DEFAULT 'JPY' CHECK (currency IN ('JPY','EUR','CHF')),
  is_from_price  INTEGER DEFAULT 0,    -- 「〜」表記かどうか。UIで誤解を生む要因
  source_url     TEXT,
  last_verified_at TEXT,
  confidence     TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (hut_id, year, plan_type)
);

-- ---------------------------------------------------------------
-- Facilities: the actual differentiator. Nobody publishes this
-- in structured form today, so most rows start NULL by design.
-- ---------------------------------------------------------------
CREATE TABLE hut_facilities (
  hut_id           TEXT PRIMARY KEY REFERENCES huts(id),
  toilet_type      TEXT CHECK (toilet_type IN ('flush','vault','composting','portable','none')),
  toilet_fee_jpy   INTEGER,
  water_available  TEXT CHECK (water_available IN ('free','paid','none')),
  power_outlet     INTEGER,
  charging_service INTEGER,
  charging_fee_jpy INTEGER,
  wifi             INTEGER,
  private_room     INTEGER,
  bath             INTEGER,
  shower           INTEGER,
  drying_room      INTEGER,
  shop             INTEGER,
  bento_available  INTEGER,
  credit_card      INTEGER,
  qr_payment       INTEGER,
  cash_only        INTEGER,
  source_url       TEXT,
  last_verified_at TEXT,
  confidence       TEXT NOT NULL DEFAULT 'unknown'
);

-- 電波は事業者ごとに違うので別テーブル
CREATE TABLE hut_mobile_signal (
  hut_id      TEXT NOT NULL REFERENCES huts(id),
  carrier     TEXT NOT NULL CHECK (carrier IN ('docomo','au','softbank','rakuten','starlink')),
  quality     TEXT CHECK (quality IN ('good','spotty','none')),
  source_url  TEXT,
  last_verified_at TEXT,
  confidence  TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (hut_id, carrier)
);

-- ---------------------------------------------------------------
-- Access: the second gap. Constraint flags matter more than schedules.
-- ---------------------------------------------------------------
CREATE TABLE trailheads (
  id           TEXT PRIMARY KEY,       -- 'nakabusa'
  name_ja      TEXT NOT NULL,
  name_en      TEXT,
  lat REAL, lon REAL, elevation_m INTEGER,
  parking_spaces INTEGER,
  parking_note TEXT,
  parking_note_en TEXT
);

CREATE TABLE access_routes (
  id            TEXT PRIMARY KEY,
  trailhead_id  TEXT NOT NULL REFERENCES trailheads(id),
  mode          TEXT NOT NULL CHECK (mode IN
                  ('bus','train','taxi','car','shuttle','ropeway','ferry')),
  operator_name TEXT,
  operator_name_en TEXT,
  from_place    TEXT,
  from_place_en TEXT,
  seasonal_only INTEGER DEFAULT 0,
  -- 南アの東海フォレスト型: 特定の小屋に泊まらないと乗れない
  requires_hut_stay INTEGER DEFAULT 0,
  reservation_required INTEGER DEFAULT 0,
  -- マイカー規制（上高地・立山など）
  private_car_restricted INTEGER DEFAULT 0,
  duration_min  INTEGER,
  fare_jpy      INTEGER,
  info_url      TEXT,
  source_url    TEXT,
  last_verified_at TEXT,
  confidence    TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE hut_trailheads (
  hut_id       TEXT NOT NULL REFERENCES huts(id),
  trailhead_id TEXT NOT NULL REFERENCES trailheads(id),
  walk_time_up_min   INTEGER,
  walk_time_down_min INTEGER,
  PRIMARY KEY (hut_id, trailhead_id)
);

-- ---------------------------------------------------------------
-- Trails: 行程からの逆引き（HutsGo の中核導線）
-- ---------------------------------------------------------------
CREATE TABLE trails (
  id          TEXT PRIMARY KEY,        -- 'omote_ginza_yari'
  name_ja     TEXT NOT NULL,
  name_en     TEXT,
  nights_typical INTEGER,
  difficulty  TEXT CHECK (difficulty IN ('easy','moderate','hard','expert')),
  summary     TEXT,
  summary_en  TEXT
);

CREATE TABLE trail_stops (
  trail_id    TEXT NOT NULL REFERENCES trails(id),
  seq         INTEGER NOT NULL,
  hut_id      TEXT REFERENCES huts(id),
  trailhead_id TEXT REFERENCES trailheads(id),
  cumulative_time_min INTEGER,
  is_overnight_candidate INTEGER DEFAULT 1,
  -- 宿泊地でない通過点（ピーク・乗越）。hut_id / trailhead_id が両方 NULL の行で使う。
  -- 標高は国土地理院の地形図値。時刻は前後の小屋間コースタイムを按分した概算。
  label       TEXT,
  label_en    TEXT,
  elevation_m INTEGER,
  PRIMARY KEY (trail_id, seq)
);

-- ---------------------------------------------------------------
-- Photos: 運営者撮影のみ（権利処理済み）。EXIF は build 前に剥がす。
-- role: 'hero' トップ / 'trail' ルート頁 / 'hut' 小屋頁 / 'teaser' 準備中山域の予告
-- ---------------------------------------------------------------
CREATE TABLE photos (
  id        TEXT PRIMARY KEY,
  file      TEXT NOT NULL,              -- static/img/<file>.jpg（-800 版も同名で存在）
  alt       TEXT NOT NULL,
  alt_en    TEXT,
  caption   TEXT,
  caption_en TEXT,
  credit    TEXT,
  role      TEXT NOT NULL CHECK (role IN ('hero','trail','hut','teaser','area')),
  hut_id    TEXT REFERENCES huts(id),
  trail_id  TEXT REFERENCES trails(id),
  range_id  TEXT REFERENCES mountain_ranges(id),
  taken_on  TEXT,
  sort      INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------
-- Reviews: the moat. Own-authored first, UGC later.
-- ---------------------------------------------------------------
CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,
  hut_id        TEXT NOT NULL REFERENCES huts(id),
  author_id     TEXT,
  author_type   TEXT NOT NULL DEFAULT 'user'
                  CHECK (author_type IN ('user','editorial')),
  stayed_on     TEXT,
  plan_type     TEXT,
  rating_overall     INTEGER CHECK (rating_overall BETWEEN 1 AND 5),
  rating_cleanliness INTEGER,
  rating_food        INTEGER,
  rating_staff       INTEGER,
  rating_crowding    INTEGER,
  body          TEXT,
  -- 本文にはリンクを入れない（投稿の URL は post.php が別枠に退避し、取り込み時に本文から消える）。
  -- リンクは 1 件だけ、この欄に運営者が手で入れる。行き先は小屋の公式サイトか自社サイトのみで、
  -- それ以外のドメインはビルドが落ちる（build.py の REVIEW_LINK_HOSTS）。スパムの出口を作らないため。
  link_url      TEXT,
  link_label    TEXT,
  link_label_en TEXT,
  verified_stay INTEGER DEFAULT 0,
  created_at    TEXT
);

-- ---------------------------------------------------------------
-- Outbound click tracking: the single most important KPI.
-- This is what you show a hut operator when you ask for an API deal.
-- ---------------------------------------------------------------
CREATE TABLE outbound_clicks (
  id          INTEGER PRIMARY KEY,
  hut_id      TEXT NOT NULL REFERENCES huts(id),
  target      TEXT NOT NULL CHECK (target IN ('official_site','reservation','phone','access')),
  occurred_at TEXT NOT NULL,
  session_id  TEXT,
  referrer    TEXT
);

CREATE INDEX idx_huts_area     ON huts(sub_area_id);
CREATE INDEX idx_seasons_year  ON hut_seasons(year, status);
CREATE INDEX idx_rates_year    ON hut_rates(year, plan_type);
CREATE INDEX idx_clicks_hut    ON outbound_clicks(hut_id, occurred_at);

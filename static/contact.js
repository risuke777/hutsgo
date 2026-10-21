/* 連絡の手引き（/plan/ から使う）。
   - 電話の台本: 日本語を話せない人が、日本語で読み上げられるように仮名＋ローマ字＋英訳を添える。
     決まり文句を短く保つ（衛星電話・悪い電波で長文は聞き取れない）。「英語を話せますか」を必ず先頭に置く。
   - Web予約フォームの用語対訳: 小屋ごとのフォームは持っていないので、汎用の対訳表だけを出す。
   - 受付開始のカレンダー登録（.ics）: 端末の中で生成するだけ。どこにも送信しない（A6）。
     計算できる小屋だけ（hut.season_2026.reservation.opens_rule がある小屋）に絞る。
     「間に合わなかった」を避けるため、計算した日時ちょうどではなく前日にも通知が出るよう VALARM を付ける。
*/
(function () {
  "use strict";

  // ---- 日付・人数の読み ------------------------------------------------
  // 標準的な日本語の月日・人数の読み方。辞書的な事実であって推測ではない。
  var MONTH = [
    null,
    { kana: "いちがつ", romaji: "ichigatsu" }, { kana: "にがつ", romaji: "nigatsu" },
    { kana: "さんがつ", romaji: "sangatsu" }, { kana: "しがつ", romaji: "shigatsu" },
    { kana: "ごがつ", romaji: "gogatsu" }, { kana: "ろくがつ", romaji: "rokugatsu" },
    { kana: "しちがつ", romaji: "shichigatsu" }, { kana: "はちがつ", romaji: "hachigatsu" },
    { kana: "くがつ", romaji: "kugatsu" }, { kana: "じゅうがつ", romaji: "juugatsu" },
    { kana: "じゅういちがつ", romaji: "juuichigatsu" }, { kana: "じゅうにがつ", romaji: "juunigatsu" }
  ];
  var DAY = [
    null,
    { kana: "ついたち", romaji: "tsuitachi" }, { kana: "ふつか", romaji: "futsuka" },
    { kana: "みっか", romaji: "mikka" }, { kana: "よっか", romaji: "yokka" },
    { kana: "いつか", romaji: "itsuka" }, { kana: "むいか", romaji: "muika" },
    { kana: "なのか", romaji: "nanoka" }, { kana: "ようか", romaji: "youka" },
    { kana: "ここのか", romaji: "kokonoka" }, { kana: "とおか", romaji: "tooka" },
    { kana: "じゅういちにち", romaji: "juuichinichi" }, { kana: "じゅうににち", romaji: "juuninichi" },
    { kana: "じゅうさんにち", romaji: "juusannichi" }, { kana: "じゅうよっか", romaji: "juuyokka" },
    { kana: "じゅうごにち", romaji: "juugonichi" }, { kana: "じゅうろくにち", romaji: "juurokunichi" },
    { kana: "じゅうしちにち", romaji: "juushichinichi" }, { kana: "じゅうはちにち", romaji: "juuhachinichi" },
    { kana: "じゅうくにち", romaji: "juukunichi" }, { kana: "はつか", romaji: "hatsuka" },
    { kana: "にじゅういちにち", romaji: "nijuuichinichi" }, { kana: "にじゅうににち", romaji: "nijuuninichi" },
    { kana: "にじゅうさんにち", romaji: "nijuusannichi" }, { kana: "にじゅうよっか", romaji: "nijuuyokka" },
    { kana: "にじゅうごにち", romaji: "nijuugonichi" }, { kana: "にじゅうろくにち", romaji: "nijuurokunichi" },
    { kana: "にじゅうしちにち", romaji: "nijuushichinichi" }, { kana: "にじゅうはちにち", romaji: "nijuuhachinichi" },
    { kana: "にじゅうくにち", romaji: "nijuukunichi" }, { kana: "さんじゅうにち", romaji: "sanjuunichi" },
    { kana: "さんじゅういちにち", romaji: "sanjuuichinichi" }
  ];
  // 「名」の読みは 1-9 が音読みそのまま（人のような特殊な読みが無い）。10 以上は「じゅう」を組み合わせる
  var ON = [null, "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"];
  var ON_R = [null, "ichi", "ni", "san", "yon", "go", "roku", "nana", "hachi", "kyuu"];

  function numKana(n) {
    if (n <= 0) return null;
    if (n < 10) return { kana: ON[n], romaji: ON_R[n] };
    if (n === 10) return { kana: "じゅう", romaji: "juu" };
    if (n < 20) return { kana: "じゅう" + ON[n - 10], romaji: "juu" + ON_R[n - 10] };
    var tens = Math.floor(n / 10), ones = n % 10;
    var kana = (tens === 1 ? "じゅう" : ON[tens] + "じゅう") + (ones ? ON[ones] : "");
    var romaji = (tens === 1 ? "juu" : ON_R[tens] + "juu") + (ones ? ON_R[ones] : "");
    return { kana: kana, romaji: romaji };
  }

  function dateReading(month, day) {
    var m = MONTH[month], d = DAY[day];
    if (!m || !d) return null;
    return { kana: m.kana + d.kana, romaji: m.romaji + " " + d.romaji };
  }

  function peopleReading(n) {
    var num = numKana(n);
    if (!num) return null;
    return { kana: num.kana + "めい", romaji: num.romaji + "-mei" };
  }

  // ---- 電話の台本 -------------------------------------------------------
  // 短い決まり文句だけにする（悪い電波・衛星電話でも聞き取れるように）。
  // 先頭に必ず「英語を話せますか」を置く：これが唯一の逃げ道になる。
  function phoneScript(params) {
    var lines = [];
    lines.push({
      ja: "もしもし、予約についてお伺いしたいです。",
      romaji: "Moshi moshi, yoyaku ni tsuite oukagai shitai desu.",
      en: "Hello, I'd like to ask about a reservation."
    });
    lines.push({
      ja: "英語を話せる方はいらっしゃいますか？",
      romaji: "Eigo o hanaseru kata wa irasshaimasu ka?",
      en: "Is there someone who speaks English?"
    });
    var dr = dateReading(params.month, params.day);
    if (dr) {
      // 表記は算用数字（誰が読んでも同じ）、読み方だけ仮名・ローマ字で添える
      lines.push({
        ja: params.month + "月" + params.day + "日に泊まりたいです。",
        romaji: dr.romaji + " ni tomaritai desu.",
        en: "I'd like to stay on " + params.dateEn + "."
      });
    }
    var pr = peopleReading(params.people || 1);
    if (pr) {
      lines.push({
        ja: (params.people || 1) + "名でお願いします。",
        romaji: pr.romaji + " de onegaishimasu.",
        en: "For " + (params.people || 1) + " " + ((params.people || 1) === 1 ? "person" : "people") + ", please."
      });
    }
    if (params.twoMeals) {
      lines.push({
        ja: "二食付きでお願いします。",
        romaji: "Nishoku-tsuki de onegaishimasu.",
        en: "With two meals (dinner and breakfast), please."
      });
    }
    lines.push({
      ja: "何か持って行くものはありますか？",
      romaji: "Nanika motte iku mono wa arimasu ka?",
      en: "Is there anything I should bring?"
    });
    lines.push({
      ja: "ありがとうございます。よろしくお願いします。",
      romaji: "Arigatou gozaimasu. Yoroshiku onegaishimasu.",
      en: "Thank you very much."
    });
    return lines;
  }

  // ---- Web予約フォームの対訳（汎用。小屋ごとのフォームは持っていない）---------
  function formGlossary() {
    return [
      ["お名前", "Name"], ["フリガナ", "Name reading (katakana) — foreign names: write it in katakana as best you can"],
      ["電話番号", "Phone number"], ["メールアドレス", "Email address"],
      ["宿泊日", "Date of stay"], ["人数", "Number of people"], ["泊数", "Number of nights"],
      ["プラン", "Plan"], ["一泊二食", "One night, two meals (dinner + breakfast)"],
      ["素泊まり", "Room only, no meals"], ["テント泊", "Tent camping"],
      ["個室", "Private room"], ["相部屋", "Shared room"],
      ["備考", "Notes"], ["ご要望", "Requests"],
      ["確認", "Confirm"], ["予約する", "Submit reservation"], ["送信", "Submit"], ["キャンセル", "Cancel"]
    ];
  }

  // ---- 受付開始日時の計算 -----------------------------------------------
  function daysInMonth(year, month1) {           // month1: 1-12 -> その月の日数
    return new Date(Date.UTC(year, month1, 0)).getUTCDate();
  }

  // 戻り値は UTC の Date（JST は常に UTC+9・サマータイム無しなので単純に引くだけでよい）
  function computeOpensUtc(rule, stayIso, seasonYear) {
    if (!rule || !rule.time) return null;
    var hm = /^(\d{1,2}):(\d{2})$/.exec(rule.time);
    if (!hm) return null;
    var hh = Number(hm[1]), mm = Number(hm[2]);
    if (rule.rule === "fixed_date" && rule.month && rule.day) {
      return new Date(Date.UTC(seasonYear, rule.month - 1, rule.day, hh - 9, mm));
    }
    if (rule.rule === "months_before_stay" && rule.offset_months && stayIso) {
      var p = stayIso.split("-").map(Number);          // [y, m, d] 宿泊日（JST の暦日として扱う）
      var y = p[0], m = p[1], d = p[2];
      var targetMonthIndex0 = m - 1 - rule.offset_months;   // 0-indexed。負なら Date.UTC が年をまたいで正しく繰り下げる
      // 対象月の日数を超える日付（例: 31日の1ヶ月前が2月）は繰り上がって別の月にずれてしまうので、その月の末日に丸める
      var targetYear = y + Math.floor(targetMonthIndex0 / 12);
      var targetMonth1 = ((targetMonthIndex0 % 12) + 12) % 12 + 1;
      var clampedDay = Math.min(d, daysInMonth(targetYear, targetMonth1));
      return new Date(Date.UTC(y, targetMonthIndex0, clampedDay, hh - 9, mm));
    }
    return null;
  }

  // ---- .ics 生成（端末の中だけ。どこにも送らない）-------------------------
  function icsEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
  }
  function icsStamp(d) {                  // UTC の Date -> "YYYYMMDDTHHMMSSZ"
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
  function buildEvent(opts) {
    var uid = "hutsgo-" + opts.hutId + "-" + icsStamp(opts.start) + "@hutsgo.com";
    return [
      "BEGIN:VEVENT",
      "UID:" + uid,
      "DTSTAMP:" + icsStamp(new Date()),
      "DTSTART:" + icsStamp(opts.start),
      "DTEND:" + icsStamp(new Date(opts.start.getTime() + 30 * 60000)),
      "SUMMARY:" + icsEscape(opts.summary),
      "DESCRIPTION:" + icsEscape(opts.description),
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(opts.summary), "TRIGGER:-P1D", "END:VALARM",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(opts.summary), "TRIGGER:-PT15M", "END:VALARM",
      "END:VEVENT"
    ].join("\r\n");
  }
  function wrapCalendar(events) {
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HutsGo//plan//JA", "CALSCALE:GREGORIAN"]
      .concat(events).concat(["END:VCALENDAR"]).join("\r\n");
  }

  // ボタンの出し分けだけに使う軽い判定（文字列は組み立てない）
  function hasComputable(entries) {
    return entries.some(function (e) {
      var rule = ((e.hut.season_2026 || {}).reservation || {}).opens_rule;
      if (!rule) return false;
      var opens = computeOpensUtc(rule, e.stayIso, e.seasonYear || 2026);
      return !!opens && opens.getTime() >= Date.now();
    });
  }

  // entries: [{ hut, stayIso, seasonYear, hutName, lang }]。計算できたものだけ使い、無理な小屋は黙って外す
  function buildIcsForEntries(entries) {
    var events = [];
    entries.forEach(function (e) {
      var res = (e.hut.season_2026 || {}).reservation || {};
      var rule = res.opens_rule;
      if (!rule) return;
      var opens = computeOpensUtc(rule, e.stayIso, e.seasonYear || 2026);
      if (!opens || opens.getTime() < Date.now()) return;   // 既に開始しているはずの日時は出さない
      var isEn = e.lang === "en";
      var summary = isEn ? "Booking opens: " + e.hutName : e.hutName + " の予約受付開始";
      var descParts = [];
      if (res.url) descParts.push(res.url);
      if (res.phone) descParts.push(isEn ? "Phone: " + res.phone : "電話: " + res.phone);
      descParts.push("https://hutsgo.com/" + (isEn ? "en/" : "") + "huts/" + e.hut.id + "/");
      events.push(buildEvent({ hutId: e.hut.id, start: opens, summary: summary, description: descParts.join("\n") }));
    });
    return events.length ? wrapCalendar(events) : null;
  }

  function downloadIcs(filename, text) {
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- 日本の外の小屋へのメール（伊・独・英）---------------------------------
  // 予約の申し込みではなく「空いていますか」の問い合わせ。CAI の決まりでは、小屋が確定と返事して初めて予約になる。
  // 名前は書かない（見ている人が自分のメールアプリで足す）。HutsGo には何も送らない
  function pad2(n) { return String(n).padStart(2, "0"); }
  function addDays(iso, n) {
    var p = iso.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2] + n);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  var MAIL = {
    it: {
      date: function (iso) { var p = iso.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; },
      people: function (n) { return n + (n === 1 ? " persona" : " persone"); },
      stay: function (a, b, n) { return n === 1 ? "per la notte del " + a : "dal " + a + " al " + b + " (" + n + " notti)"; },
      plan: { hb: "in mezza pensione", bb: "con pernottamento e prima colazione", bo: "solo pernottamento" },
      room: { any: "in camerata o in camera (indifferente)", dorm: "in camerata", room: "in camera" },
      subject: function (a, n) { return "Richiesta di disponibilità – " + a + ", " + n; },
      body: function (o) {
        return "Buongiorno,\n\nvorremmo sapere se avete posto " + o.stay + " per " + o.people + ", " + o.plan + ", " + o.room + ".\n" +
          (o.members ? "Siamo soci di un club alpino (porteremo la tessera).\n" : "") +
          "\nSe c'è posto, potete confermarci la prenotazione? Se è richiesta una caparra, come possiamo pagarla?\n\nGrazie mille e cordiali saluti,\n";
      }
    },
    de: {
      date: function (iso) { var p = iso.split("-"); return p[2] + "." + p[1] + "." + p[0]; },
      people: function (n) { return n + (n === 1 ? " Person" : " Personen"); },
      stay: function (a, b, n) { return n === 1 ? "für die Nacht vom " + a + " auf den " + b : "vom " + a + " bis " + b + " (" + n + " Nächte)"; },
      plan: { hb: "mit Halbpension", bb: "mit Übernachtung und Frühstück", bo: "nur Übernachtung" },
      room: { any: "im Lager oder im Zimmer (egal)", dorm: "im Lager", room: "im Zimmer" },
      subject: function (a, n) { return "Anfrage – " + a + ", " + n; },
      body: function (o) {
        return "Guten Tag,\n\nhaben Sie noch Platz " + o.stay + " für " + o.people + ", " + o.plan + ", " + o.room + "?\n" +
          (o.members ? "Wir sind Mitglieder eines Alpenvereins (Ausweis bringen wir mit).\n" : "") +
          "\nWenn ja, können Sie uns die Reservierung bestätigen? Falls eine Anzahlung nötig ist: wie können wir sie bezahlen?\n\nVielen Dank und freundliche Grüße\n";
      }
    },
    en: {
      date: function (iso) {
        var p = iso.split("-").map(Number);
        return p[2] + " " + ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][p[1] - 1] + " " + p[0];
      },
      people: function (n) { return n + (n === 1 ? " person" : " people"); },
      stay: function (a, b, n) { return n === 1 ? "for the night of " + a : "from " + a + " to " + b + " (" + n + " nights)"; },
      plan: { hb: "half board", bb: "bed and breakfast", bo: "bed only" },
      room: { any: "dormitory or room (either is fine)", dorm: "in the dormitory", room: "in a room" },
      subject: function (a, n) { return "Availability request – " + a + ", " + n; },
      body: function (o) {
        return "Hello,\n\ndo you have space " + o.stay + " for " + o.people + ", " + o.plan + ", " + o.room + "?\n" +
          (o.members ? "We are members of an alpine club (we will bring our cards).\n" : "") +
          "\nIf so, could you confirm the booking? If a deposit is needed, how can we pay it?\n\nMany thanks and best regards,\n";
      }
    }
  };
  // opts: { lang: "it"|"de"|"en", start: "YYYY-MM-DD"（最初の夜）, nights, people, plan: "hb"|"bb"|"bo", room: "any"|"dorm"|"room", members }
  function bookingMail(opts) {
    var L = MAIL[opts.lang] || MAIL.en;
    var n = Math.max(1, opts.nights || 1);
    var a = L.date(opts.start), b = L.date(addDays(opts.start, n === 1 ? 1 : n));
    var people = L.people(opts.people || 1);
    return {
      subject: L.subject(a, people),
      body: L.body({ stay: L.stay(a, b, n), people: people, plan: L.plan[opts.plan] || L.plan.hb,
                     room: L.room[opts.room] || L.room.any, members: !!opts.members })
    };
  }

  window.HutsGoContact = {
    bookingMail: bookingMail,
    dateReading: dateReading,
    peopleReading: peopleReading,
    phoneScript: phoneScript,
    formGlossary: formGlossary,
    computeOpensUtc: computeOpensUtc,
    daysInMonth: daysInMonth,
    hasComputable: hasComputable,
    buildIcsForEntries: buildIcsForEntries,
    downloadIcs: downloadIcs
  };
})();

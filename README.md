# MAXIMA

Egyszerű LAN-os multiplayer kártyajáték kliens/szerver:

- valódi regisztráció és bejelentkezés
- SQLite adatbázis, ezért a felhasználók/paklik nem vesznek el attól, hogy bezárod a böngészőt
- közös lobby chat
- 8 különböző, jelenleg csak vizuális kártya
- pakliépítő
- több pakli létrehozása és kiválasztása
- kiválasztott paklival matchmaking
- egyszerű meccsszoba, ahol a két játékos és a paklijuk látszik
- Socket.IO a valós idejű chathez és matchmakinghez

## Követelmény

Node.js 18+ ajánlott.

## Indítás

```bash
npm install
npm start
```

A szerver alapból a `3000`-as porton indul.

Ugyanazon a gépen:

```text
http://localhost:3000
```

LAN-on a szervert futtató gép helyi IP-címével:

```text
http://192.168.1.100:3000
```

A szerver konzoljában az induláskor kiírja az elérhető helyi címeket.

## Adatok és feltöltött fájlok

Az adatbázis itt jön létre:

```text
data/cardgame.db
```

A tartósan megőrzendő feltöltések szintén a `data/` mappában vannak:

```text
data/uploads/cards/
data/uploads/avatars/
data/uploads/music/
```

A jelszavak hash-elve vannak tárolva. A `public/` könyvtár a build része és lecserélhető; a `data/` mappa viszont az alkalmazás tartós adata.

## Első használat

1. Regisztrálj egy felhasználót.
2. Jelentkezz be.
3. A `Paklik` résznél készíts egy paklit.
4. Adj hozzá legalább 1 kártyát.
5. Állítsd be aktívnak.
6. Menj vissza a főmenübe és indíts matchmakinget.
7. Egy másik böngészőből / LAN gépről jelentkezz be másik felhasználóval és szintén indíts matchmakinget.

## Megjegyzés

A kártyák jelenleg szándékosan nem rendelkeznek játékmechanikával. A meccsszoba az alap multiplayer infrastruktúrát demonstrálja; a tényleges körök, húzás, kijátszás, életerő stb. később építhető rá.

## Profilok és játékosok

- Online játékosok külön `Játékosok` oldalon
- Minden játékosnak publikus profilja van
- Profilkép feltöltése JPG/PNG/WEBP/GIF formátumban, legfeljebb 1 MB
- Legfeljebb 100 karakteres bemutatkozás
- A profil mutatja a lejátszott/meccsbe került meccsek számát és a kapott lájkok számát
- Más profilján csak a lájkok száma látható
- Saját profilodon megtekinthető, pontosan kik lájkoltak
- A lájk bármikor visszavonható
- A profilok és lájkok SQLite-ban maradnak meg

A korábbi adatbázisok automatikusan megkapják az új profil- és meccsszámláló mezőket az indításkor.

## Developer Center, Hírek, Értesítések

- A `server.js` tetején az `ADMIN_USERNAMES` tömbbe írt felhasználónevek kapnak fejlesztői jogot (induláskor szinkronizálódik az adatbázisba).
- Fejlesztők a `Fejlesztői Központ` menüpontban tehetnek közzé híreket (cím + szöveg).
- A `Hírek` oldalon mindenki látja a közzétett bejegyzéseket, valós időben (Socket.IO).
- A harang ikon a fejlécben mutatja az olvasatlan értesítéseket. Értesítés érkezik:
  - új hír megjelenésekor,
  - ha valaki lájkolja a profilodat,
  - ha meccstársat talál a matchmaking.
- Az értesítések a `data/cardgame.db`-ben tárolódnak, tehát bezárás után is megmaradnak.

## Chat: profilkép, admin-kiemelés, spam-védelem

- Minden chatüzenet mellett megjelenik a küldő aktuális profilképe és felhasználóneve; mindkettőre kattintva megnyílik a profilja.
- Ha fejlesztői jogú felhasználó ír, az üzenete kiemelve jelenik meg egy "FEJLESZTŐ" jelvénnyel.
- Egyszerű, memóriában tárolt spam-védelem fut a szerveren: max. ~6 üzenet / 10 mp, minimum 0,5 mp az üzenetek között, és nem lehet 3-nál többször egymás után ugyanazt az üzenetet elküldeni.

## Fejlesztői Központ: statisztikák

A `Fejlesztői Központ` oldalon (csak adminoknak) az alábbi statisztikák jelennek meg:

- Regisztrált játékosok száma, jelenleg online játékosok száma
- Összes lejátszott meccs, ebből az elmúlt 24 órában lejátszottak
- Létrehozott paklik, elküldött chatüzenetek, közzétett hírek, kiosztott lájkok száma
- Új regisztrációk az elmúlt 7 napban
- A legtöbb lájkot kapott játékos
- A paklikban legtöbbször szereplő kártya
- Óránkénti online csúcslétszám oszlopdiagram az elmúlt 24 órából (a szerver 15 percenként, illetve minden be-/kijelentkezéskor pillanatképet ment a `presence_log` táblába)

## Adatok perzisztenciája új build-ek között

Minden játékadat — felhasználók, profilok, paklik, meccsstatisztikák, hírek, kártyák — a `data/cardgame.db` SQLite fájlban él, ami **különálló a kódtól**. Ha egy új build-nél lecseréled a `server.js`/`public` fájlokat, de a `data/` mappát meghagyod, semmi nem vész el: induláskor a szerver csak `CREATE TABLE IF NOT EXISTS` és `ALTER TABLE ... ADD COLUMN` migrációkat futtat, sosem törli a meglévő táblákat.

**Fontos:** amikor egy új verziót telepítesz, mindig másold át (vagy hagyd érintetlenül) a **teljes `data/` mappát** a régi telepítésből az újba. Ez tartalmazza az adatbázist **és** az összes feltöltött kártyaképet, profilképet, valamint a menüzenét. A build cseréje így nem törli ezeket.

A régebbi MAXIMA build-eknél a feltöltések még a `public/uploads/` alatt lehetnek. Az új szerver első induláskor automatikusan átmásolja onnan a még hiányzó fájlokat a `data/uploads/` alá, így egyszerűen át lehet térni az új tárolásra.

## Kártyakészítő és perzisztens képek

- A kártyák konfigurációja és adatai SQLite-ban élnek; új build telepítésekor a `data/cardgame.db` megőrzésével tovább élnek.
- A teljes kártyaképek PNG-ként a `data/uploads/cards/` mappába kerülnek.
- A profilképek a `data/uploads/avatars/` mappába kerülnek.
- A fejlesztői központból feltöltött menüzene a `data/uploads/music/` mappába kerül.
- A kliens ezeket az `/uploads/...` útvonalon éri el, ezért a build `public/` részének cseréje nem törli a képeket.

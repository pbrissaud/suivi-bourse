# Changelog

## [5.3.0](https://github.com/pbrissaud/suivi-bourse/compare/v5.2.0...v5.3.0) (2026-10-31)


### Features

* **agent:** an investor profile the agent proposes and the user confirms ([#1247](https://github.com/pbrissaud/suivi-bourse/issues/1247)) ([fae01a4](https://github.com/pbrissaud/suivi-bourse/commit/fae01a40687291533a452bd34a1703c687c41839))
* **agent:** cache the analyst's stable prompt prefix, and drop the unused page line ([#1246](https://github.com/pbrissaud/suivi-bourse/issues/1246)) ([cf8185a](https://github.com/pbrissaud/suivi-bourse/commit/cf8185af43212c22ffaf1a42fcd657ed52671f7d)), closes [#1190](https://github.com/pbrissaud/suivi-bourse/issues/1190)
* **agent:** let the owner choose how hard the analyst thinks ([#1348](https://github.com/pbrissaud/suivi-bourse/issues/1348)) ([0a22a63](https://github.com/pbrissaud/suivi-bourse/commit/0a22a63c549424f4c3aa8cb388f974da5544484a))
* **agent:** propose ledger events and merge them through the import preview ([#1362](https://github.com/pbrissaud/suivi-bourse/issues/1362)) ([27fa6f5](https://github.com/pbrissaud/suivi-bourse/commit/27fa6f5c1ba5d233c6e8f3fbf2aa68428fd17034))
* **agent:** the conversation loop on an async /agent route, the agent's settings and key in the store, threads in JSON ([#1182](https://github.com/pbrissaud/suivi-bourse/issues/1182)) ([2f0d9fd](https://github.com/pbrissaud/suivi-bourse/commit/2f0d9fda30dc7cb5a6b10de06777f5626212e541))
* **agent:** turn a broker statement into proposed events ([#1465](https://github.com/pbrissaud/suivi-bourse/issues/1465)) ([57ac56f](https://github.com/pbrissaud/suivi-bourse/commit/57ac56f1515e682cabea7be4e3a657ae83f02180))
* **app:** follow several reference ETFs, downloaded in the background ([#1464](https://github.com/pbrissaud/suivi-bourse/issues/1464)) ([ad2a65f](https://github.com/pbrissaud/suivi-bourse/commit/ad2a65f0068c5db2dd69e1bbef1d3b1fb100a2b2))
* **app:** let the agent read the benchmark comparison ([#1323](https://github.com/pbrissaud/suivi-bourse/issues/1323)) ([f739021](https://github.com/pbrissaud/suivi-bourse/commit/f7390214b6783cb9ce2560ca44cf16183ef1bd0f))
* **app:** SB_DOCUMENTATION_URL, one overridable root for every call and link to the documentation site ([#1448](https://github.com/pbrissaud/suivi-bourse/issues/1448)) ([de46aec](https://github.com/pbrissaud/suivi-bourse/commit/de46aec825e51950345e7405bd240f7e6756d893))
* **auth:** an optional PIN behind one gate in front of the whole socket ([#1239](https://github.com/pbrissaud/suivi-bourse/issues/1239)) ([9c02dc4](https://github.com/pbrissaud/suivi-bourse/commit/9c02dc4eb41978f76ff485ec3d2731fc6a4a1405))
* **design:** separate the gain colour from the action colour ([#1322](https://github.com/pbrissaud/suivi-bourse/issues/1322)) ([aa1ef2f](https://github.com/pbrissaud/suivi-bourse/commit/aa1ef2f6cc4fc17a07f64c810aca8c7cb9167120))
* **import:** accept several files at once and show the expected columns ([#1353](https://github.com/pbrissaud/suivi-bourse/issues/1353)) ([b6528fd](https://github.com/pbrissaud/suivi-bourse/commit/b6528fda52c99da44cf007179a279c75e29d041c))
* **mcp:** remove simulate_arbitrage and the taxation wrapper templates ([#1168](https://github.com/pbrissaud/suivi-bourse/issues/1168)) ([a0dee8a](https://github.com/pbrissaud/suivi-bourse/commit/a0dee8ac22671526543a844aabf1d6bf797de5be))
* **mcp:** serve the sale and arbitrage simulators as MCP tools ([#1127](https://github.com/pbrissaud/suivi-bourse/issues/1127)) ([8dc1203](https://github.com/pbrissaud/suivi-bourse/commit/8dc1203c9f10fd8e058f48be50c04fae99983ed8))
* **settings:** import taxation presets published as a JSON on the docs site ([#1349](https://github.com/pbrissaud/suivi-bourse/issues/1349)) ([3acde42](https://github.com/pbrissaud/suivi-bourse/commit/3acde42c665d325737a86df41d39ef8330b9c4dd))
* **settings:** switch the agent on in four guided steps, with the key kept server-side ([#1189](https://github.com/pbrissaud/suivi-bourse/issues/1189)) ([a9d3fae](https://github.com/pbrissaud/suivi-bourse/commit/a9d3faebcdae694b4cc14562e5a34fb639bb6ad4))
* **simulation:** simulate a sale and a CTO-to-PEA arbitrage, net of tax ([#1123](https://github.com/pbrissaud/suivi-bourse/issues/1123)) ([394583f](https://github.com/pbrissaud/suivi-bourse/commit/394583ffc3e394514bb9b9386b14d441d7701ebd))
* **web:** a dashboard card that says whether the portfolio beats its index ([#1231](https://github.com/pbrissaud/suivi-bourse/issues/1231)) ([37171b3](https://github.com/pbrissaud/suivi-bourse/commit/37171b31eb65c3dbcf8a9eeaf50be5cbb85a12f8)), closes [#1205](https://github.com/pbrissaud/suivi-bourse/issues/1205)
* **web:** a dashboard card that shows where the money is, by security or by account ([#1230](https://github.com/pbrissaud/suivi-bourse/issues/1230)) ([a131e0b](https://github.com/pbrissaud/suivi-bourse/commit/a131e0b32dd13ec24ae4a9eb323bcedbe9399ba5))
* **web:** a third dashboard grid track from 1 600 px ([#1456](https://github.com/pbrissaud/suivi-bourse/issues/1456)) ([b6dd47a](https://github.com/pbrissaud/suivi-bourse/commit/b6dd47a887ce32094e398f1a9f8f5905f434630f))
* **web:** drag the dashboard's cards into place ([#1141](https://github.com/pbrissaud/suivi-bourse/issues/1141)) ([c349d82](https://github.com/pbrissaud/suivi-bourse/commit/c349d82e22803cc67478ea25c01d2bef7511d766))
* **web:** give the dashboard and benchmark charts readable axes ([#1296](https://github.com/pbrissaud/suivi-bourse/issues/1296)) ([a8b7f4c](https://github.com/pbrissaud/suivi-bourse/commit/a8b7f4c19821b8461f7b1b7ed53775e9f90b222d))
* **web:** give the product a mark of its own ([#1447](https://github.com/pbrissaud/suivi-bourse/issues/1447)) ([66e94fc](https://github.com/pbrissaud/suivi-bourse/commit/66e94fc797f15ef688b9829c3cdf31ad63ebc640))
* **web:** lay the DESIGN.md foundations: warm tokens, the section plane, the card rule ([#1128](https://github.com/pbrissaud/suivi-bourse/issues/1128)) ([b2aae74](https://github.com/pbrissaud/suivi-bourse/commit/b2aae74149d87f2b04d7a9b6509a9a748ee10976)), closes [#1111](https://github.com/pbrissaud/suivi-bourse/issues/1111)
* **web:** let the gain breakdown answer over a window chosen in the card ([#1173](https://github.com/pbrissaud/suivi-bourse/issues/1173)) ([1967d6e](https://github.com/pbrissaud/suivi-bourse/commit/1967d6e4b3b38d49f3ad72344208fa1daac943a0))
* **web:** let the owner arrange the dashboard on a two-width grid ([#1139](https://github.com/pbrissaud/suivi-bourse/issues/1139)) ([f5456b8](https://github.com/pbrissaud/suivi-bourse/commit/f5456b83ea3dd9aa7e409beb74f48e6221ea6cab))
* **web:** load any tweakcn theme from SB_TWEAKCN_THEME, semantic tokens as aliases of shadcn's ([#1137](https://github.com/pbrissaud/suivi-bourse/issues/1137)) ([176865f](https://github.com/pbrissaud/suivi-bourse/commit/176865f0f3d1d143e3fa0dbd9b505c3063c82adf))
* **web:** one layout system for the shell (sidebar width, navigation groups, heading scale, content widths) ([#1301](https://github.com/pbrissaud/suivi-bourse/issues/1301)) ([ede1663](https://github.com/pbrissaud/suivi-bourse/commit/ede1663a16eda0556a4e7e44f30ab6161e29e4fe)), closes [#1276](https://github.com/pbrissaud/suivi-bourse/issues/1276)
* **web:** put the portfolio value first on the dashboard ([#1099](https://github.com/pbrissaud/suivi-bourse/issues/1099)) ([91a58aa](https://github.com/pbrissaud/suivi-bourse/commit/91a58aa732fe12b41d396064c4e15c659e5b9c80))
* **web:** reconcile the return figures the app shows ([#1263](https://github.com/pbrissaud/suivi-bourse/issues/1263)) ([#1294](https://github.com/pbrissaud/suivi-bourse/issues/1294)) ([1c97397](https://github.com/pbrissaud/suivi-bourse/commit/1c973972e75803efa6004b836ba63922ddbe980a))
* **web:** refresh the figures by polling, recompose the value, say when the API stops answering ([#1181](https://github.com/pbrissaud/suivi-bourse/issues/1181)) ([1889f59](https://github.com/pbrissaud/suivi-bourse/commit/1889f59d41ccd2da1d4ecb6527701d241fdda417))
* **web:** say when a newer release is available ([#1242](https://github.com/pbrissaud/suivi-bourse/issues/1242)) ([27cb44e](https://github.com/pbrissaud/suivi-bourse/commit/27cb44ecfc787a1d8ea7ce1d4ea7ad8fe9a04868))
* **website:** list the European taxation regimes and what to enter for each ([#1343](https://github.com/pbrissaud/suivi-bourse/issues/1343)) ([7914ead](https://github.com/pbrissaud/suivi-bourse/commit/7914ead4e514e9978473948a43ef93d092e11ec7))
* **web:** store the theme as JSON, editable in Settings, importable from tweakcn ([#1249](https://github.com/pbrissaud/suivi-bourse/issues/1249)) ([4b0b46d](https://github.com/pbrissaud/suivi-bourse/commit/4b0b46ddaa67176f299edb083dc06314fe4d95c2))
* **web:** the agent gets its own page, /agent, and leaves the side panel ([#1211](https://github.com/pbrissaud/suivi-bourse/issues/1211)) ([6b9803b](https://github.com/pbrissaud/suivi-bourse/commit/6b9803b49391ac37da217de7fed00697a7dcf703))
* **web:** the agent's tool calls are shadcn Trace lines, their raw call a Code Block ([#1233](https://github.com/pbrissaud/suivi-bourse/issues/1233)) ([248cb64](https://github.com/pbrissaud/suivi-bourse/commit/248cb643c12416ebd0d82ea78cc5b496f888053f))
* **web:** the analyst panel: layouts, states, readable tool calls, accessibility ([#1192](https://github.com/pbrissaud/suivi-bourse/issues/1192)) ([39761b9](https://github.com/pbrissaud/suivi-bourse/commit/39761b982885c8ea68e54f56e686fab62b0ec6d2))
* **web:** the dashboard's composition (pill hierarchy, chart controls, default sections) ([#1332](https://github.com/pbrissaud/suivi-bourse/issues/1332)) ([2887235](https://github.com/pbrissaud/suivi-bourse/commit/2887235f2ff27336ad321b29464a4c4bf9192eef))
* **web:** the event form says how much cash leaves or enters the account ([#1472](https://github.com/pbrissaud/suivi-bourse/issues/1472)) ([fd54d07](https://github.com/pbrissaud/suivi-bourse/commit/fd54d07d877be587e7b73200405c8240fa9bbb53))
* **web:** the ledger is a list on phones ([#1345](https://github.com/pbrissaud/suivi-bourse/issues/1345)) ([a148e14](https://github.com/pbrissaud/suivi-bourse/commit/a148e144cc6fd0e74bb8d53e1d3d1a4ec56e857d))
* **web:** the Shares page is a list on phones ([#1344](https://github.com/pbrissaud/suivi-bourse/issues/1344)) ([f86b7ce](https://github.com/pbrissaud/suivi-bourse/commit/f86b7ce5d1556f5fd807782d1fd923184bc5f8c9))
* **web:** the System page shows each job's run history ([#1245](https://github.com/pbrissaud/suivi-bourse/issues/1245)) ([b9db4fc](https://github.com/pbrissaud/suivi-bourse/commit/b9db4fc2d7b36c7fc14337b0f86700af63efb59a))


### Bug Fixes

* **agent:** a key that failed the connection test is stored, and the provider's error is shown raw ([#1300](https://github.com/pbrissaud/suivi-bourse/issues/1300)) ([c14b2df](https://github.com/pbrissaud/suivi-bourse/commit/c14b2dfe2db9edeae89ad7ec554ddf0d8e802728))
* **agent:** forget the provider's key when its kind or address changes ([#1208](https://github.com/pbrissaud/suivi-bourse/issues/1208)) ([a36d3c2](https://github.com/pbrissaud/suivi-bourse/commit/a36d3c2a4a7afbfe1bc5abaf17367aee194d1614))
* **agent:** keep a stopped or failed turn's partial answer ([#1365](https://github.com/pbrissaud/suivi-bourse/issues/1365)) ([ab1b203](https://github.com/pbrissaud/suivi-bourse/commit/ab1b20313355728ff73cfb9ff3dc3d86126e1f22))
* **api:** compare each mover against its own previous close ([#1163](https://github.com/pbrissaud/suivi-bourse/issues/1163)) ([3ddaa8b](https://github.com/pbrissaud/suivi-bourse/commit/3ddaa8b3784c066608a060cf3d3f43c1b1bbc8f3))
* **app:** a newly chosen reference no longer waits behind the held symbols ([#1466](https://github.com/pbrissaud/suivi-bourse/issues/1466)) ([9252147](https://github.com/pbrissaud/suivi-bourse/commit/92521478016be57d45aa220723dfc81dbd78d1a7)), closes [#1336](https://github.com/pbrissaud/suivi-bourse/issues/1336)
* **app:** back off a failing history fetch and stop waiting on an unreachable symbol ([#1364](https://github.com/pbrissaud/suivi-bourse/issues/1364)) ([93b773f](https://github.com/pbrissaud/suivi-bourse/commit/93b773ff6546033615af237e9e504308ffc42c8e)), closes [#1288](https://github.com/pbrissaud/suivi-bourse/issues/1288)
* **app:** future-dated trades wait their day in today's positions ([#1469](https://github.com/pbrissaud/suivi-bourse/issues/1469)) ([69d94ee](https://github.com/pbrissaud/suivi-bourse/commit/69d94ee87023554aa1d8722b0011d3ff5fffbc91))
* **app:** keep scheduling.py clear of flake8 W503 and W504 ([#1473](https://github.com/pbrissaud/suivi-bourse/issues/1473)) ([0b1e931](https://github.com/pbrissaud/suivi-bourse/commit/0b1e9318f5a8d57d694842759b048072b3692c71))
* **app:** say how many held symbols wait for their market on the System page ([#1444](https://github.com/pbrissaud/suivi-bourse/issues/1444)) ([b749514](https://github.com/pbrissaud/suivi-bourse/commit/b7495143f790f3c2917862661f6d7ba2700e355d)), closes [#1357](https://github.com/pbrissaud/suivi-bourse/issues/1357)
* **app:** send a User-Agent on outbound fetches so Cloudflare stops refusing them ([#1457](https://github.com/pbrissaud/suivi-bourse/issues/1457)) ([b0b26e0](https://github.com/pbrissaud/suivi-bourse/commit/b0b26e083dbd4826da25fafc26d86e583cb8d77d))
* **app:** store quote prices as quoted, without Yahoo's float32 noise ([#1468](https://github.com/pbrissaud/suivi-bourse/issues/1468)) ([7c59c62](https://github.com/pbrissaud/suivi-bourse/commit/7c59c62092edd088ef984c6b9fce0e86bec301a9))
* **app:** the portfolio.csv export states the figures the app states ([#1470](https://github.com/pbrissaud/suivi-bourse/issues/1470)) ([3fe66a8](https://github.com/pbrissaud/suivi-bourse/commit/3fe66a88d0c3e05de18e6f06ea8d8964f5c1c1d0))
* **app:** write the closing auction's print as the day's close ([#1467](https://github.com/pbrissaud/suivi-bourse/issues/1467)) ([503403a](https://github.com/pbrissaud/suivi-bourse/commit/503403a82d99eefcd17397c46af3ba3c8df441b3)), closes [#1352](https://github.com/pbrissaud/suivi-bourse/issues/1352)
* **benchmark:** keep free grants in the comparison instead of excluding the account ([#1193](https://github.com/pbrissaud/suivi-bourse/issues/1193)) ([5bfe594](https://github.com/pbrissaud/suivi-bourse/commit/5bfe594a8bee55fd1aa6e966594e7d847c0686f2))
* **benchmark:** keep the seed-day rule for free grants and pin it with tests ([#1347](https://github.com/pbrissaud/suivi-bourse/issues/1347)) ([81ab091](https://github.com/pbrissaud/suivi-bourse/commit/81ab091c8b75af1e6b5e0e32462900c0932a5e0d)), closes [#1194](https://github.com/pbrissaud/suivi-bourse/issues/1194)
* **benchmark:** name why there is nothing to compare, instead of telling an owner with events to record their first ones ([#1217](https://github.com/pbrissaud/suivi-bourse/issues/1217)) ([ad0ded0](https://github.com/pbrissaud/suivi-bourse/commit/ad0ded04c1a18b604777fabfb13143e2f0f6cf42))
* **benchmark:** replay every account together over the whole portfolio's period ([#1195](https://github.com/pbrissaud/suivi-bourse/issues/1195)) ([ab7c4eb](https://github.com/pbrissaud/suivi-bourse/commit/ab7c4eb435d5ae3425951cca629106367e58ec46))
* **ci:** pin Python to 3.14, the version the image runs ([#1124](https://github.com/pbrissaud/suivi-bourse/issues/1124)) ([747d5dc](https://github.com/pbrissaud/suivi-bourse/commit/747d5dc8bde9484da0427708f659a3c7c01c4e54))
* **events:** refuse a dividend fee above its amount, and cap the stored ones ([#1179](https://github.com/pbrissaud/suivi-bourse/issues/1179)) ([26b13e7](https://github.com/pbrissaud/suivi-bourse/commit/26b13e71a00bdffeeb51ebf1eb14a48fb88063ea))
* **import:** ask about the currency of foreign-listed lines in the import preview, not after the write ([#1293](https://github.com/pbrissaud/suivi-bourse/issues/1293)) ([3828d62](https://github.com/pbrissaud/suivi-bourse/commit/3828d6202177cee68e3f3d769f29c8d25ceabb56))
* **import:** read semicolon-separated CSV files ([#1097](https://github.com/pbrissaud/suivi-bourse/issues/1097)) ([10cdba5](https://github.com/pbrissaud/suivi-bourse/commit/10cdba5f4b93ba0bca5353fc8032ffeaffec6318))
* **import:** write a line repeated inside the same file when the reader asks ([#1298](https://github.com/pbrissaud/suivi-bourse/issues/1298)) ([c7dd81a](https://github.com/pbrissaud/suivi-bourse/commit/c7dd81abe178c4e608c9c578f809a1ef695c5ee5))
* **web:** a figure's sign follows the rounded figure shown ([#1361](https://github.com/pbrissaud/suivi-bourse/issues/1361)) ([6223121](https://github.com/pbrissaud/suivi-bourse/commit/6223121409592de3e5a61da15a32b79bcc2e9186))
* **web:** a quiet page title in the header bar ([#1310](https://github.com/pbrissaud/suivi-bourse/issues/1310)) ([8f4f87d](https://github.com/pbrissaud/suivi-bourse/commit/8f4f87d7a7084393b98df00b487526285f1d5a35))
* **web:** Accounts head, add-account reach and Répartition fold ([#1440](https://github.com/pbrissaud/suivi-bourse/issues/1440)) ([365cd9f](https://github.com/pbrissaud/suivi-bourse/commit/365cd9fbbb6c041a37ffc318ff07f533afabe225))
* **web:** agent proposals come under the answer, and the wait is a line ([#1326](https://github.com/pbrissaud/suivi-bourse/issues/1326)) ([8eaf7be](https://github.com/pbrissaud/suivi-bourse/commit/8eaf7bee6e9565e2ff25b69ae4c6e83a435372ae))
* **web:** delete ledger events by checkbox selection, not by "the reduction" ([#1125](https://github.com/pbrissaud/suivi-bourse/issues/1125)) ([4207da9](https://github.com/pbrissaud/suivi-bourse/commit/4207da9b37f1b702deafd41659efbfb22c3103c3))
* **web:** draw no rank on a one-line movers list ([#1159](https://github.com/pbrissaud/suivi-bourse/issues/1159)) ([90a175c](https://github.com/pbrissaud/suivi-bourse/commit/90a175c87ee4db715780b5caa93cfff1ce468acc)), closes [#1147](https://github.com/pbrissaud/suivi-bourse/issues/1147)
* **web:** draw the gain breakdown as a cascade that adds up to the total ([#1161](https://github.com/pbrissaud/suivi-bourse/issues/1161)) ([cf09658](https://github.com/pbrissaud/suivi-bourse/commit/cf0965824ce7281ac8267e102e819db9e234253f))
* **web:** event form refusals land below the fold, and a free ticker is accepted ([#1299](https://github.com/pbrissaud/suivi-bourse/issues/1299)) ([be5b0a6](https://github.com/pbrissaud/suivi-bourse/commit/be5b0a67360f29f7d14bf3a29afd8b81bfab8553))
* **web:** give the dashboard edit link and the ⓘ a 24 px hit area, 44 px on touch ([#1160](https://github.com/pbrissaud/suivi-bourse/issues/1160)) ([2f7b466](https://github.com/pbrissaud/suivi-bourse/commit/2f7b466ff854d8b71905394d59a6ec0ea4010f54))
* **web:** keep a short movers list in one column at full width ([#1158](https://github.com/pbrissaud/suivi-bourse/issues/1158)) ([e190abe](https://github.com/pbrissaud/suivi-bourse/commit/e190abe5339bb90a9ee0b1cf7af4accdffe62795)), closes [#1145](https://github.com/pbrissaud/suivi-bourse/issues/1145)
* **web:** lighten the dashboard hero: cash under the value, year-to-date pill, no stat row ([#1178](https://github.com/pbrissaud/suivi-bourse/issues/1178)) ([54be6be](https://github.com/pbrissaud/suivi-bourse/commit/54be6bef0923c8d61876e47a924c2cea00b83058))
* **web:** make the gain breakdown a statement, with no drawing and no window ([#1176](https://github.com/pbrissaud/suivi-bourse/issues/1176)) ([749af7f](https://github.com/pbrissaud/suivi-bourse/commit/749af7f01f157bb32e4986034455c29d7c1cc87b))
* **web:** name the cash in the dashboard stat row, so « Titres » adds up to the value ([#1170](https://github.com/pbrissaud/suivi-bourse/issues/1170)) ([e0715aa](https://github.com/pbrissaud/suivi-bourse/commit/e0715aa23aaabc548567528c4ae9f94fff380e53)), closes [#1151](https://github.com/pbrissaud/suivi-bourse/issues/1151)
* **web:** neutral progress and benchmark bars, a status glyph, and Atelier gutters ([#1441](https://github.com/pbrissaud/suivi-bourse/issues/1441)) ([dc5494a](https://github.com/pbrissaud/suivi-bourse/commit/dc5494a7872c1004682aceed3b0b336ee609df2a)), closes [#1427](https://github.com/pbrissaud/suivi-bourse/issues/1427) [#1428](https://github.com/pbrissaud/suivi-bourse/issues/1428) [#1429](https://github.com/pbrissaud/suivi-bourse/issues/1429) [#1431](https://github.com/pbrissaud/suivi-bourse/issues/1431)
* **web:** one word per term, trimmed supporting copy and single-action empty states ([#1443](https://github.com/pbrissaud/suivi-bourse/issues/1443)) ([070bfba](https://github.com/pbrissaud/suivi-bourse/commit/070bfba6acbc096419df7b5c6f40b8606b951d78)), closes [#1412](https://github.com/pbrissaud/suivi-bourse/issues/1412)
* **web:** put the Benchmark period in the header and the picker first ([#1334](https://github.com/pbrissaud/suivi-bourse/issues/1334)) ([55037c9](https://github.com/pbrissaud/suivi-bourse/commit/55037c9a5debeb2826d485f28c96cb7d18d989fb)), closes [#1282](https://github.com/pbrissaud/suivi-bourse/issues/1282)
* **web:** put the chart's reading and range on one control bar ([#1171](https://github.com/pbrissaud/suivi-bourse/issues/1171)) ([93deeb1](https://github.com/pbrissaud/suivi-bourse/commit/93deeb12f5fe5f4efc80cc25fb959c567c85159f)), closes [#1150](https://github.com/pbrissaud/suivi-bourse/issues/1150)
* **web:** put the IRR in the hero's third pill and the year-to-date gain in the stat row ([#1167](https://github.com/pbrissaud/suivi-bourse/issues/1167)) ([192b94c](https://github.com/pbrissaud/suivi-bourse/commit/192b94cfca391ce2afe3b40695827841d01a3328)), closes [#1149](https://github.com/pbrissaud/suivi-bourse/issues/1149)
* **web:** quick wins from the 17/10 UX audit ([#1259](https://github.com/pbrissaud/suivi-bourse/issues/1259)) ([58e8680](https://github.com/pbrissaud/suivi-bourse/commit/58e868093083161adbd18abe499ccfde206f93cf))
* **web:** rank the movers by the size of their move ([#1220](https://github.com/pbrissaud/suivi-bourse/issues/1220)) ([28d41fb](https://github.com/pbrissaud/suivi-bourse/commit/28d41fb282812d072d87999e654d63f51753d993))
* **web:** say only what is true when the app does not answer ([#1401](https://github.com/pbrissaud/suivi-bourse/issues/1401)) ([79fc114](https://github.com/pbrissaud/suivi-bourse/commit/79fc114f4b3a2dde207d7e2bbe7d6fbba0b87d1b)), closes [#1356](https://github.com/pbrissaud/suivi-bourse/issues/1356)
* **web:** say the movers footnote once when every hidden line is unchanged ([#1157](https://github.com/pbrissaud/suivi-bourse/issues/1157)) ([5e9f904](https://github.com/pbrissaud/suivi-bourse/commit/5e9f904e7427e75617e2b0920fb5c2bf9752a1a5)), closes [#1146](https://github.com/pbrissaud/suivi-bourse/issues/1146)
* **web:** server reasons on refused imports and events, plurals and ledger amounts ([#1442](https://github.com/pbrissaud/suivi-bourse/issues/1442)) ([9e80760](https://github.com/pbrissaud/suivi-bourse/commit/9e8076013d201d7c09f53236985307e807617455))
* **web:** Settings focus, touch targets, index links and truthful errors ([#1439](https://github.com/pbrissaud/suivi-bourse/issues/1439)) ([5e2f5c6](https://github.com/pbrissaud/suivi-bourse/commit/5e2f5c677e8f8cfc9ea1a275743b11e07e2030bb))
* **web:** shell, navigation and dialog overflow UX fixes ([#1438](https://github.com/pbrissaud/suivi-bourse/issues/1438)) ([5f46bfb](https://github.com/pbrissaud/suivi-bourse/commit/5f46bfbc615d6098073ce84cd413394516ca4f16))
* **web:** show a trade's quantity where the ledger has no room for its Montant column ([#1366](https://github.com/pbrissaud/suivi-bourse/issues/1366)) ([c4346a5](https://github.com/pbrissaud/suivi-bourse/commit/c4346a58b45ffb703054e5c9c94151e7cea735bc)), closes [#1355](https://github.com/pbrissaud/suivi-bourse/issues/1355)
* **web:** show one performance figure per screen, and the net-of-tax line under the value ([#1133](https://github.com/pbrissaud/suivi-bourse/issues/1133)) ([38de3b0](https://github.com/pbrissaud/suivi-bourse/commit/38de3b01acf234dcd54584cb54954aece3712fcc))
* **web:** small UX polish from the October 17 audit ([#1341](https://github.com/pbrissaud/suivi-bourse/issues/1341)) ([37d4feb](https://github.com/pbrissaud/suivi-bourse/commit/37d4febc2954370dde402ea0a1e5466a2e32ee84))
* **web:** stop one large month from flattening the investment rhythm chart ([#1172](https://github.com/pbrissaud/suivi-bourse/issues/1172)) ([3e02bae](https://github.com/pbrissaud/suivi-bourse/commit/3e02bae2d06fafd36ca8546eb9094ba430bd1632)), closes [#1152](https://github.com/pbrissaud/suivi-bourse/issues/1152)
* **web:** tables on the background, the Benchmark head on the ground, merged share markers ([#1340](https://github.com/pbrissaud/suivi-bourse/issues/1340)) ([cf171c0](https://github.com/pbrissaud/suivi-bourse/commit/cf171c0b5cff78feba218f459f11df80f8caa8db))
* **web:** the accounts page reads like the dashboard's head ([#1329](https://github.com/pbrissaud/suivi-bourse/issues/1329)) ([4c39f0f](https://github.com/pbrissaud/suivi-bourse/commit/4c39f0febecbd5f6cf818a4da96bc9b98097c895))
* **web:** the Accounts panel no longer shows a truncated past day as current ([#1363](https://github.com/pbrissaud/suivi-bourse/issues/1363)) ([8cc891f](https://github.com/pbrissaud/suivi-bourse/commit/8cc891f6de15803fdffc1c91a04debc3ca57bcf8))
* **web:** the agent page draws Markdown, asks before deleting a thread, and opens on the last question ([#1218](https://github.com/pbrissaud/suivi-bourse/issues/1218)) ([819271b](https://github.com/pbrissaud/suivi-bourse/commit/819271b2c523fa888d7e94fd91f72b22472ee428))
* **web:** the dashboard hero no longer shows the cash alone while the history is rebuilding ([#1291](https://github.com/pbrissaud/suivi-bourse/issues/1291)) ([dcf173d](https://github.com/pbrissaud/suivi-bourse/commit/dcf173d9ebcebfbaf7849dc949f6813263b42da0)), closes [#1260](https://github.com/pbrissaud/suivi-bourse/issues/1260)
* **web:** the first-run walk is lost on reload once the currency is answered ([#1292](https://github.com/pbrissaud/suivi-bourse/issues/1292)) ([f40078e](https://github.com/pbrissaud/suivi-bourse/commit/f40078e0a253c56bc2474ee7660e350a2334a9f9))
* **web:** the ledger page layout (filters as a toolbar, import as a button, contextual selection actions) ([#1302](https://github.com/pbrissaud/suivi-bourse/issues/1302)) ([b3c13b6](https://github.com/pbrissaud/suivi-bourse/commit/b3c13b6eb747e5193b8405cc49101952cf71aaf5))
* **web:** the ledger table overflows its column by 60 % at 1440 px ([#1297](https://github.com/pbrissaud/suivi-bourse/issues/1297)) ([35415e5](https://github.com/pbrissaud/suivi-bourse/commit/35415e5fb57a22df089c62286b19611efb6d53db))
* **web:** the Shares page layout (one allocation drawing, table toolbar, totals row, density) ([#1333](https://github.com/pbrissaud/suivi-bourse/issues/1333)) ([099aec8](https://github.com/pbrissaud/suivi-bourse/commit/099aec873b421c5ef6dec4e3336a9052f190af5a)), closes [#1281](https://github.com/pbrissaud/suivi-bourse/issues/1281)


### Dependencies

* **app:** update dependency packaging to v26.3 ([#1243](https://github.com/pbrissaud/suivi-bourse/issues/1243)) ([29ef27e](https://github.com/pbrissaud/suivi-bourse/commit/29ef27ef17f2a277d6b1c499a6450ea478b423b2))
* **app:** update dependency pydantic-ai-slim to v2.56.0 ([#1250](https://github.com/pbrissaud/suivi-bourse/issues/1250)) ([85ce753](https://github.com/pbrissaud/suivi-bourse/commit/85ce753d6c11dfb9e8c6307d01ccce0db506862f))
* **app:** update dependency pydantic-ai-slim to v2.57.0 ([#1317](https://github.com/pbrissaud/suivi-bourse/issues/1317)) ([28bda52](https://github.com/pbrissaud/suivi-bourse/commit/28bda528c58a2649c524ad6fe1836c65f2440fb8))
* **app:** update dependency pydantic-ai-slim to v2.58.0 ([#1380](https://github.com/pbrissaud/suivi-bourse/issues/1380)) ([16fcec2](https://github.com/pbrissaud/suivi-bourse/commit/16fcec2c5e6425ddc41ebc8daf3da4e0559e47c6))
* **app:** update dependency pydantic-ai-slim to v2.59.0 ([#1390](https://github.com/pbrissaud/suivi-bourse/issues/1390)) ([3ae8aa6](https://github.com/pbrissaud/suivi-bourse/commit/3ae8aa6e05c4eecc84c5d6ff674aff3fe112f73f))
* **app:** update dependency pydantic-ai-slim to v2.60.0 ([#1407](https://github.com/pbrissaud/suivi-bourse/issues/1407)) ([d77d1ed](https://github.com/pbrissaud/suivi-bourse/commit/d77d1ed162a886968bc51bf6038d8419c0e596ab))
* **app:** update dependency pydantic-ai-slim to v2.61.0 ([#1415](https://github.com/pbrissaud/suivi-bourse/issues/1415)) ([98b290a](https://github.com/pbrissaud/suivi-bourse/commit/98b290afeb6f2e85bf59239c2b7eac1d4d11bf6c))
* **app:** update dependency uv_build to &gt;=0.13,&lt;0.14 ([#1215](https://github.com/pbrissaud/suivi-bourse/issues/1215)) ([ffd2566](https://github.com/pbrissaud/suivi-bourse/commit/ffd25667e013718638c6bbff4012c316381977f2))
* **repo:** update astral-sh/setup-uv action to v10.3.0 ([#1186](https://github.com/pbrissaud/suivi-bourse/issues/1186)) ([4a78653](https://github.com/pbrissaud/suivi-bourse/commit/4a7865388c9dec781324227135b3e08ef54679f9))
* **repo:** update astral-sh/setup-uv action to v10.3.1 ([#1394](https://github.com/pbrissaud/suivi-bourse/issues/1394)) ([0235474](https://github.com/pbrissaud/suivi-bourse/commit/0235474148e9bc300381b1286497a7799feff42a))
* **repo:** update astral-sh/setup-uv action to v10.3.2 ([#1398](https://github.com/pbrissaud/suivi-bourse/issues/1398)) ([8533270](https://github.com/pbrissaud/suivi-bourse/commit/85332708ab3cdf11ecaa466cc69b3eed4738e516))
* **repo:** update dependency node to v26 ([#1424](https://github.com/pbrissaud/suivi-bourse/issues/1424)) ([5565f84](https://github.com/pbrissaud/suivi-bourse/commit/5565f8438a3d48b0501d2f8b7356125d53ef41b4))
* **website:** update pnpm to v12.10.0 ([#1104](https://github.com/pbrissaud/suivi-bourse/issues/1104)) ([19ac324](https://github.com/pbrissaud/suivi-bourse/commit/19ac3248ac9f0b2b0fae0130dc5d2fe20cafee10))
* **website:** update pnpm to v12.10.1 ([#1105](https://github.com/pbrissaud/suivi-bourse/issues/1105)) ([8928006](https://github.com/pbrissaud/suivi-bourse/commit/8928006a84888d2ad559c1f91b09eb08fddf961a))
* **website:** update pnpm to v12.11.0 ([#1165](https://github.com/pbrissaud/suivi-bourse/issues/1165)) ([e17c151](https://github.com/pbrissaud/suivi-bourse/commit/e17c1516487813a5fe14a501abb37e68c13aa8d9))
* **website:** update pnpm to v12.11.1 ([#1177](https://github.com/pbrissaud/suivi-bourse/issues/1177)) ([ae8f36f](https://github.com/pbrissaud/suivi-bourse/commit/ae8f36f43e995ffb8566135388a451142b5fd187))
* **website:** update pnpm to v12.11.2 ([#1184](https://github.com/pbrissaud/suivi-bourse/issues/1184)) ([f97350a](https://github.com/pbrissaud/suivi-bourse/commit/f97350a4a87eefa0c4c6383d84e8c74f14124be6))
* **website:** update pnpm to v12.13.0 ([#1234](https://github.com/pbrissaud/suivi-bourse/issues/1234)) ([4f1ff6a](https://github.com/pbrissaud/suivi-bourse/commit/4f1ff6a12a12e17e7eeb38802c4698d1d0c7891d))
* **website:** update pnpm to v12.14.0 ([#1309](https://github.com/pbrissaud/suivi-bourse/issues/1309)) ([a691585](https://github.com/pbrissaud/suivi-bourse/commit/a69158587550662137d32347bd6d360b2c7c24f0))
* **website:** update pnpm to v12.15.0 ([#1393](https://github.com/pbrissaud/suivi-bourse/issues/1393)) ([60669e2](https://github.com/pbrissaud/suivi-bourse/commit/60669e25d54b5a6471918919dee8b585c699d726))
* **website:** update pnpm to v12.16.0 ([#1451](https://github.com/pbrissaud/suivi-bourse/issues/1451)) ([bfc3509](https://github.com/pbrissaud/suivi-bourse/commit/bfc3509f301022545d3f3c9557b85a73411a60ef))
* **website:** update pnpm to v12.16.1 ([#1455](https://github.com/pbrissaud/suivi-bourse/issues/1455)) ([adc60d2](https://github.com/pbrissaud/suivi-bourse/commit/adc60d240dfd616f5612c06f2cfb760cdc61b38b))
* **website:** update react monorepo to v19.3.1 ([#1287](https://github.com/pbrissaud/suivi-bourse/issues/1287)) ([46c37d4](https://github.com/pbrissaud/suivi-bourse/commit/46c37d42a12723aed187b5584d95d6347eff3f90))
* **web:** update dependency @ai-sdk/react to v4.0.141 ([#1222](https://github.com/pbrissaud/suivi-bourse/issues/1222)) ([942a5b4](https://github.com/pbrissaud/suivi-bourse/commit/942a5b484d937a61d0fc08e8004432b4b09d1464))
* **web:** update dependency @ai-sdk/react to v4.0.142 ([#1240](https://github.com/pbrissaud/suivi-bourse/issues/1240)) ([e5339eb](https://github.com/pbrissaud/suivi-bourse/commit/e5339ebbc6e12b1c57e9906fae976ab29b9da458))
* **web:** update dependency @ai-sdk/react to v4.0.143 ([#1251](https://github.com/pbrissaud/suivi-bourse/issues/1251)) ([89b62eb](https://github.com/pbrissaud/suivi-bourse/commit/89b62ebd4473796fab8219645087eba1a8466bbf))
* **web:** update dependency @ai-sdk/react to v4.0.145 ([#1304](https://github.com/pbrissaud/suivi-bourse/issues/1304)) ([991a86b](https://github.com/pbrissaud/suivi-bourse/commit/991a86bb2a5ca09265c8bb95326ae12048f368a7))
* **web:** update dependency @ai-sdk/react to v4.0.146 ([#1315](https://github.com/pbrissaud/suivi-bourse/issues/1315)) ([a6dcce1](https://github.com/pbrissaud/suivi-bourse/commit/a6dcce10bf63a427bc5214c2b8f5df0bb4a3626a))
* **web:** update dependency @ai-sdk/react to v4.0.147 ([#1327](https://github.com/pbrissaud/suivi-bourse/issues/1327)) ([33f6a11](https://github.com/pbrissaud/suivi-bourse/commit/33f6a114d6dd3f0b792d1b7cf207e80e527fe31a))
* **web:** update dependency @ai-sdk/react to v4.0.149 ([#1369](https://github.com/pbrissaud/suivi-bourse/issues/1369)) ([ad4c336](https://github.com/pbrissaud/suivi-bourse/commit/ad4c336f926b4c6e98d4dc98b9300b6de44ad721))
* **web:** update dependency @ai-sdk/react to v4.0.150 ([#1378](https://github.com/pbrissaud/suivi-bourse/issues/1378)) ([598c5d0](https://github.com/pbrissaud/suivi-bourse/commit/598c5d0c0f5e35c75341a90849ed3f7a0b905728))
* **web:** update dependency @ai-sdk/react to v4.0.151 ([#1382](https://github.com/pbrissaud/suivi-bourse/issues/1382)) ([8afbc79](https://github.com/pbrissaud/suivi-bourse/commit/8afbc79c66b5e83ac0eebd5e94f22988a08091c6))
* **web:** update dependency @ai-sdk/react to v4.0.152 ([#1384](https://github.com/pbrissaud/suivi-bourse/issues/1384)) ([4cdb233](https://github.com/pbrissaud/suivi-bourse/commit/4cdb2331c63200aae4695a443ab177030e3a68e5))
* **web:** update dependency @ai-sdk/react to v4.0.153 ([#1402](https://github.com/pbrissaud/suivi-bourse/issues/1402)) ([be7e422](https://github.com/pbrissaud/suivi-bourse/commit/be7e422a0d5c55e1d72c6ba503e5a00bd1e92054))
* **web:** update dependency @ai-sdk/react to v4.0.154 ([#1404](https://github.com/pbrissaud/suivi-bourse/issues/1404)) ([4b1bb07](https://github.com/pbrissaud/suivi-bourse/commit/4b1bb07bb01838b95e7dcd991fe67ed7592d93e2))
* **web:** update dependency @ai-sdk/react to v4.0.156 ([#1413](https://github.com/pbrissaud/suivi-bourse/issues/1413)) ([23cb93a](https://github.com/pbrissaud/suivi-bourse/commit/23cb93a0279af4fc06552b0c66e2d6f3ff0cbfe3))
* **web:** update dependency @ai-sdk/react to v4.0.157 ([#1422](https://github.com/pbrissaud/suivi-bourse/issues/1422)) ([255da89](https://github.com/pbrissaud/suivi-bourse/commit/255da89b8fa089c688343821f4edf125dd48477d))
* **web:** update dependency @ai-sdk/react to v4.0.158 ([#1449](https://github.com/pbrissaud/suivi-bourse/issues/1449)) ([98ddcf3](https://github.com/pbrissaud/suivi-bourse/commit/98ddcf3510bc853dfa66e148ea604441e6cb9819))
* **web:** update dependency @ai-sdk/react to v4.0.159 ([#1462](https://github.com/pbrissaud/suivi-bourse/issues/1462)) ([2922d88](https://github.com/pbrissaud/suivi-bourse/commit/2922d8809212951db01fe5c7462006e1a777fc81))
* **web:** update dependency @biomejs/biome to v2.6.2 ([#1391](https://github.com/pbrissaud/suivi-bourse/issues/1391)) ([89c4239](https://github.com/pbrissaud/suivi-bourse/commit/89c42395b577e7d27ec971ea26dec29db0285839))
* **web:** update dependency @biomejs/biome to v2.6.3 ([#1421](https://github.com/pbrissaud/suivi-bourse/issues/1421)) ([631ae1b](https://github.com/pbrissaud/suivi-bourse/commit/631ae1b68a0a7b482c60e844203006ea64ce6524))
* **web:** update dependency @shadcn/helpers to ^0.3.0 ([#1320](https://github.com/pbrissaud/suivi-bourse/issues/1320)) ([1f5bb2a](https://github.com/pbrissaud/suivi-bourse/commit/1f5bb2adf0ba1c2c6ce1045c735c02cf20a3cc47))
* **web:** update dependency @tanstack/react-query to v5.104.2 ([#1209](https://github.com/pbrissaud/suivi-bourse/issues/1209)) ([1fa7b47](https://github.com/pbrissaud/suivi-bourse/commit/1fa7b47db5203f898904ad4dc2b02096468cc3f6))
* **web:** update dependency @tanstack/react-query to v5.104.3 ([#1306](https://github.com/pbrissaud/suivi-bourse/issues/1306)) ([a2753de](https://github.com/pbrissaud/suivi-bourse/commit/a2753dec9d4a2867f6e121f811c6b699dd3b6d1c))
* **web:** update dependency @tanstack/react-query to v5.104.4 ([#1350](https://github.com/pbrissaud/suivi-bourse/issues/1350)) ([eaafb3e](https://github.com/pbrissaud/suivi-bourse/commit/eaafb3ea5d5a1037d1aecc2818b9b17f8acec7b7))
* **web:** update dependency @tanstack/react-query to v5.104.5 ([#1370](https://github.com/pbrissaud/suivi-bourse/issues/1370)) ([59937b0](https://github.com/pbrissaud/suivi-bourse/commit/59937b0cc621c21a9eb0f6977a89783898ca24b4))
* **web:** update dependency @tanstack/react-query to v5.105.0 ([#1445](https://github.com/pbrissaud/suivi-bourse/issues/1445)) ([30cbe5f](https://github.com/pbrissaud/suivi-bourse/commit/30cbe5fd39dcbb98c24ea6f758e6f7b40750affd))
* **web:** update dependency @tanstack/react-router to v1.170.42 ([#1187](https://github.com/pbrissaud/suivi-bourse/issues/1187)) ([f6bc5fe](https://github.com/pbrissaud/suivi-bourse/commit/f6bc5fe02b7767f582f7179c209fda9077a7d21e))
* **web:** update dependency @tanstack/react-router to v1.170.44 ([#1224](https://github.com/pbrissaud/suivi-bourse/issues/1224)) ([3189075](https://github.com/pbrissaud/suivi-bourse/commit/3189075974b96637eff68451d2e96d01d9ae87eb))
* **web:** update dependency @tanstack/react-router to v1.170.45 ([#1328](https://github.com/pbrissaud/suivi-bourse/issues/1328)) ([e3f5e47](https://github.com/pbrissaud/suivi-bourse/commit/e3f5e475e6e327b9ca25d517bdaee6054fb4cce3))
* **web:** update dependency @tanstack/react-router to v1.170.46 ([#1405](https://github.com/pbrissaud/suivi-bourse/issues/1405)) ([a9cfdef](https://github.com/pbrissaud/suivi-bourse/commit/a9cfdef8661f32af9a3ffe9df8f5cc68f49901f3))
* **web:** update dependency @tanstack/react-table to v9.3.1 ([#1226](https://github.com/pbrissaud/suivi-bourse/issues/1226)) ([9d63dfe](https://github.com/pbrissaud/suivi-bourse/commit/9d63dfe9bf0b88f4d9d434d6d7ea0745fc767d6c))
* **web:** update dependency @testing-library/user-event to v14.6.8 ([#1227](https://github.com/pbrissaud/suivi-bourse/issues/1227)) ([ee2e419](https://github.com/pbrissaud/suivi-bourse/commit/ee2e4199b33c773c24a62752cb5520f50c470935))
* **web:** update dependency @types/node to v26.6.5 ([#1183](https://github.com/pbrissaud/suivi-bourse/issues/1183)) ([9a5c70b](https://github.com/pbrissaud/suivi-bourse/commit/9a5c70b0693879a16d82182e95072bf6dd3e26f9))
* **web:** update dependency @vitejs/plugin-react to v6.1.2 ([#1100](https://github.com/pbrissaud/suivi-bourse/issues/1100)) ([6255321](https://github.com/pbrissaud/suivi-bourse/commit/6255321abae4283a81e3b407e5615e8243141be2))
* **web:** update dependency ai to v7.0.138 ([#1223](https://github.com/pbrissaud/suivi-bourse/issues/1223)) ([0742c15](https://github.com/pbrissaud/suivi-bourse/commit/0742c15d9473de6d56d738b57fd6fdf596913266))
* **web:** update dependency ai to v7.0.139 ([#1241](https://github.com/pbrissaud/suivi-bourse/issues/1241)) ([97ec270](https://github.com/pbrissaud/suivi-bourse/commit/97ec270fa3737efb6d18c00877a27a0b867e512e))
* **web:** update dependency ai to v7.0.140 ([#1252](https://github.com/pbrissaud/suivi-bourse/issues/1252)) ([0759c0e](https://github.com/pbrissaud/suivi-bourse/commit/0759c0efb9f1571f6ebf36f2786e256edbdcfa17))
* **web:** update dependency ai to v7.0.141 ([#1305](https://github.com/pbrissaud/suivi-bourse/issues/1305)) ([f3c986a](https://github.com/pbrissaud/suivi-bourse/commit/f3c986acaa5adcf3a3c94976af740e6a03459b5a))
* **web:** update dependency ai to v7.0.142 ([#1316](https://github.com/pbrissaud/suivi-bourse/issues/1316)) ([7225ce4](https://github.com/pbrissaud/suivi-bourse/commit/7225ce4372bacb8b7e7f499c3413a5c22e9bbc68))
* **web:** update dependency ai to v7.0.143 ([#1330](https://github.com/pbrissaud/suivi-bourse/issues/1330)) ([e2fdc4b](https://github.com/pbrissaud/suivi-bourse/commit/e2fdc4b0ec0dd913e928dfb7c2e74e5d17ce01aa))
* **web:** update dependency ai to v7.0.145 ([#1371](https://github.com/pbrissaud/suivi-bourse/issues/1371)) ([8db71c1](https://github.com/pbrissaud/suivi-bourse/commit/8db71c199f751cee69c4791af76abb81a4a30900))
* **web:** update dependency ai to v7.0.146 ([#1379](https://github.com/pbrissaud/suivi-bourse/issues/1379)) ([62c07ad](https://github.com/pbrissaud/suivi-bourse/commit/62c07ad3de2a3da2b8440d8b250b7968cd331f3a))
* **web:** update dependency ai to v7.0.147 ([#1383](https://github.com/pbrissaud/suivi-bourse/issues/1383)) ([1fb226c](https://github.com/pbrissaud/suivi-bourse/commit/1fb226c708df8088bbe029c7d92e3c02dadb57fa))
* **web:** update dependency ai to v7.0.148 ([#1385](https://github.com/pbrissaud/suivi-bourse/issues/1385)) ([df311de](https://github.com/pbrissaud/suivi-bourse/commit/df311dea5d473af52e6eedf568f6bad6a82dd6b9))
* **web:** update dependency ai to v7.0.149 ([#1403](https://github.com/pbrissaud/suivi-bourse/issues/1403)) ([c69c528](https://github.com/pbrissaud/suivi-bourse/commit/c69c5285a991adab23f3c3c994174e8894545cf9))
* **web:** update dependency ai to v7.0.150 ([#1406](https://github.com/pbrissaud/suivi-bourse/issues/1406)) ([e6c3734](https://github.com/pbrissaud/suivi-bourse/commit/e6c37340307487d74ca3a7b8a52ddfc487477a56))
* **web:** update dependency ai to v7.0.152 ([#1414](https://github.com/pbrissaud/suivi-bourse/issues/1414)) ([3633a7e](https://github.com/pbrissaud/suivi-bourse/commit/3633a7eb9fc227ef2a77ee86a0d484ead9c2ea99))
* **web:** update dependency ai to v7.0.153 ([#1423](https://github.com/pbrissaud/suivi-bourse/issues/1423)) ([dad5e82](https://github.com/pbrissaud/suivi-bourse/commit/dad5e828e5395b916fc3adc92e0bae47bd2bd6b7))
* **web:** update dependency ai to v7.0.154 ([#1450](https://github.com/pbrissaud/suivi-bourse/issues/1450)) ([45b6014](https://github.com/pbrissaud/suivi-bourse/commit/45b60147783921c2c4695d81138dd6879accb2dc))
* **web:** update dependency ai to v7.0.155 ([#1463](https://github.com/pbrissaud/suivi-bourse/issues/1463)) ([c7c95cb](https://github.com/pbrissaud/suivi-bourse/commit/c7c95cb019ad11b1873e0d33aebac91d115aadf4))
* **web:** update dependency cn to ^0.5.0 ([#1321](https://github.com/pbrissaud/suivi-bourse/issues/1321)) ([f48beb3](https://github.com/pbrissaud/suivi-bourse/commit/f48beb3ec13465c80b091894579a5f6c8d89bd50))
* **web:** update dependency intl-messageformat to v12.1.3 ([#1101](https://github.com/pbrissaud/suivi-bourse/issues/1101)) ([eb66f66](https://github.com/pbrissaud/suivi-bourse/commit/eb66f667b68945cd2cac6a45cdd5fca3887f527f))
* **web:** update dependency intl-messageformat to v12.1.4 ([#1372](https://github.com/pbrissaud/suivi-bourse/issues/1372)) ([0ee8ef6](https://github.com/pbrissaud/suivi-bourse/commit/0ee8ef6a478ef60a00e34c80c9d8ba0949dc46d8))
* **web:** update dependency jsdom to v30.1.3 ([#1307](https://github.com/pbrissaud/suivi-bourse/issues/1307)) ([9d7dade](https://github.com/pbrissaud/suivi-bourse/commit/9d7dadec21b8f7cbb5375b46f9b7d02b16f388b5))
* **web:** update dependency json-schema-to-typescript to v16 ([#1232](https://github.com/pbrissaud/suivi-bourse/issues/1232)) ([c4119bf](https://github.com/pbrissaud/suivi-bourse/commit/c4119bf8c5e870808c74c8c164a8e3556289be65))
* **web:** update dependency lucide-react to v1.53.0 ([#1138](https://github.com/pbrissaud/suivi-bourse/issues/1138)) ([22b6e30](https://github.com/pbrissaud/suivi-bourse/commit/22b6e3009a515be0f01a1f2f95f34a9bbe04a1ad))
* **web:** update dependency lucide-react to v1.54.0 ([#1164](https://github.com/pbrissaud/suivi-bourse/issues/1164)) ([847baf2](https://github.com/pbrissaud/suivi-bourse/commit/847baf2fdf3fe1d699320a3d107c4ed42b9d251f))
* **web:** update dependency lucide-react to v1.55.0 ([#1188](https://github.com/pbrissaud/suivi-bourse/issues/1188)) ([ae1b92b](https://github.com/pbrissaud/suivi-bourse/commit/ae1b92b9a2d4d294ce60001fd7efe37e4c8e12d3))
* **web:** update dependency lucide-react to v1.56.0 ([#1228](https://github.com/pbrissaud/suivi-bourse/issues/1228)) ([6ed4722](https://github.com/pbrissaud/suivi-bourse/commit/6ed4722257d76a7c02a7d4c3462440f1bd6f5c51))
* **web:** update dependency lucide-react to v1.57.0 ([#1258](https://github.com/pbrissaud/suivi-bourse/issues/1258)) ([56c1b37](https://github.com/pbrissaud/suivi-bourse/commit/56c1b37c5a49ccc55689e29d6b3829a4ce7e675c))
* **web:** update dependency lucide-react to v1.58.0 ([#1318](https://github.com/pbrissaud/suivi-bourse/issues/1318)) ([5d28e5d](https://github.com/pbrissaud/suivi-bourse/commit/5d28e5d2deb593afe3484e6ed3b023f344053b40))
* **web:** update dependency lucide-react to v1.59.0 ([#1335](https://github.com/pbrissaud/suivi-bourse/issues/1335)) ([c7be003](https://github.com/pbrissaud/suivi-bourse/commit/c7be0030c0e21babddba6ae14b133542e18fcf36))
* **web:** update dependency lucide-react to v1.60.0 ([#1381](https://github.com/pbrissaud/suivi-bourse/issues/1381)) ([4fd3d74](https://github.com/pbrissaud/suivi-bourse/commit/4fd3d748cb60a711c00139a64132675b40eff86f))
* **web:** update dependency lucide-react to v1.61.0 ([#1392](https://github.com/pbrissaud/suivi-bourse/issues/1392)) ([eb63fed](https://github.com/pbrissaud/suivi-bourse/commit/eb63fedf24e958efea54e9c5a84c5fe8cb15e88d))
* **web:** update dependency lucide-react to v1.62.0 ([#1453](https://github.com/pbrissaud/suivi-bourse/issues/1453)) ([04c5eb3](https://github.com/pbrissaud/suivi-bourse/commit/04c5eb3d1b97a50946b8f9dbc23ac26fddc95573))
* **web:** update dependency msw to v3.0.3 ([#1185](https://github.com/pbrissaud/suivi-bourse/issues/1185)) ([2fdd5a8](https://github.com/pbrissaud/suivi-bourse/commit/2fdd5a8a37d276bc05a315873e793797cbb54ca8))
* **web:** update dependency radix-ui to v1.7.0 ([#1102](https://github.com/pbrissaud/suivi-bourse/issues/1102)) ([0f0e42b](https://github.com/pbrissaud/suivi-bourse/commit/0f0e42b33cc30193783aa1182567217349d678dd))
* **web:** update dependency radix-ui to v1.8.0 ([#1216](https://github.com/pbrissaud/suivi-bourse/issues/1216)) ([558390b](https://github.com/pbrissaud/suivi-bourse/commit/558390bb305e4ed99f0a95d02e0fc1b034479842))
* **web:** update dependency radix-ui to v1.8.1 ([#1225](https://github.com/pbrissaud/suivi-bourse/issues/1225)) ([885175b](https://github.com/pbrissaud/suivi-bourse/commit/885175baa6c600579cd0ddd9294b2676ce18d87a))
* **web:** update dependency shadcn to v4.22.0 ([#1331](https://github.com/pbrissaud/suivi-bourse/issues/1331)) ([729b150](https://github.com/pbrissaud/suivi-bourse/commit/729b15034111b359672459d3562d4cc0c79daba2))
* **web:** update dependency shadcn to v4.22.1 ([#1367](https://github.com/pbrissaud/suivi-bourse/issues/1367)) ([98a9e98](https://github.com/pbrissaud/suivi-bourse/commit/98a9e98beaf54f260d5b5be88c3b3afae23f6c65))
* **web:** update dependency shadcn to v4.23.0 ([#1454](https://github.com/pbrissaud/suivi-bourse/issues/1454)) ([a15c78c](https://github.com/pbrissaud/suivi-bourse/commit/a15c78c4019eec0a303161881b8eec070ff85737))
* **web:** update dependency vite to v8.3.3 ([#1103](https://github.com/pbrissaud/suivi-bourse/issues/1103)) ([7934ec9](https://github.com/pbrissaud/suivi-bourse/commit/7934ec9154bbf740e3d60f3bf0f948ff9c773586))
* **web:** update dependency vite to v8.3.4 ([#1140](https://github.com/pbrissaud/suivi-bourse/issues/1140)) ([8b60fae](https://github.com/pbrissaud/suivi-bourse/commit/8b60fae489b81c3df85907a0b3911dda0bf669e7))
* **web:** update dependency vite to v8.3.5 ([#1389](https://github.com/pbrissaud/suivi-bourse/issues/1389)) ([f10de52](https://github.com/pbrissaud/suivi-bourse/commit/f10de523eb162ee3b851c37cbba7fd8caaf83104))
* **web:** update dependency vitest to v5.0.4 ([#1221](https://github.com/pbrissaud/suivi-bourse/issues/1221)) ([4288a65](https://github.com/pbrissaud/suivi-bourse/commit/4288a65a2fc00c2ae5c67fea75065402f98af183))
* **web:** update dependency vitest to v5.0.5 ([#1308](https://github.com/pbrissaud/suivi-bourse/issues/1308)) ([312cecc](https://github.com/pbrissaud/suivi-bourse/commit/312cecc8c107143abf9d9b716b46a5198b814642))
* **web:** update dnd-kit monorepo to v0.5.1 ([#1311](https://github.com/pbrissaud/suivi-bourse/issues/1311)) ([6099d20](https://github.com/pbrissaud/suivi-bourse/commit/6099d20940266b66264e5af89f209069f4d36437))

## [5.2.0](https://github.com/pbrissaud/suivi-bourse/compare/v5.1.2...v5.2.0) (2026-10-07)


### Features

* a symbol can be tracked without being held ([#991](https://github.com/pbrissaud/suivi-bourse/issues/991)) ([3c29520](https://github.com/pbrissaud/suivi-bourse/commit/3c295208c486a63b2fa3a159f9690b129bc1f5ae))
* **benchmark:** compare the invested pot only, with dividends counted on both sides ([#1022](https://github.com/pbrissaud/suivi-bourse/issues/1022)) ([6a26b54](https://github.com/pbrissaud/suivi-bourse/commit/6a26b541d8b2e8df030ecf08711c8a3723ab696c))
* **benchmark:** compare the portfolio against an index fund ([#760](https://github.com/pbrissaud/suivi-bourse/issues/760)) ([#1004](https://github.com/pbrissaud/suivi-bourse/issues/1004)) ([c807c4f](https://github.com/pbrissaud/suivi-bourse/commit/c807c4fdc85d2a0bdaab57736e6311a3572b06c6))
* **benchmark:** offer one flat list of references, with no index twice ([#1021](https://github.com/pbrissaud/suivi-bourse/issues/1021)) ([f52f296](https://github.com/pbrissaud/suivi-bourse/commit/f52f29677b9e624d85ea17252c3729f361fa41b7)), closes [#1019](https://github.com/pbrissaud/suivi-bourse/issues/1019)
* **benchmark:** publish each account's comparison over its own window ([#1024](https://github.com/pbrissaud/suivi-bourse/issues/1024)) ([50dd188](https://github.com/pbrissaud/suivi-bourse/commit/50dd18870ffcd5fcec8064a59cbda2b018449186))
* **benchmark:** split the gap into what the securities did and what the dates did ([#1017](https://github.com/pbrissaud/suivi-bourse/issues/1017)) ([61a0e21](https://github.com/pbrissaud/suivi-bourse/commit/61a0e21b5c30466e4bcacdcc79de2b10137c81d0))
* **benchmark:** state what the dates did beside what the securities did ([#1023](https://github.com/pbrissaud/suivi-bourse/issues/1023)) ([a793eb7](https://github.com/pbrissaud/suivi-bourse/commit/a793eb7a468ef7d08d59d8618e13a3682e09fb6b))
* **ledger:** suggest the grant price off the closest close ([#1029](https://github.com/pbrissaud/suivi-bourse/issues/1029)) ([3628614](https://github.com/pbrissaud/suivi-bourse/commit/36286146684564017675c2643186120900a90f0f)), closes [#1007](https://github.com/pbrissaud/suivi-bourse/issues/1007)
* **mcp:** hold each description to the schema its tool publishes ([#1043](https://github.com/pbrissaud/suivi-bourse/issues/1043)) ([a5eb4a3](https://github.com/pbrissaud/suivi-bourse/commit/a5eb4a3d241baca4d1f773bdc44f76e718fc0f92))
* **web:** give every chart a non-visual reading, and stop hiding the ones that navigate ([#1067](https://github.com/pbrissaud/suivi-bourse/issues/1067)) ([07ce74c](https://github.com/pbrissaud/suivi-bourse/commit/07ce74cdcc0b4e9d43ed24581222e02df0a26e90))
* **web:** lay the benchmark page out verdict first, then the curves ([#1041](https://github.com/pbrissaud/suivi-bourse/issues/1041)) ([2f2c92f](https://github.com/pbrissaud/suivi-bourse/commit/2f2c92fc7a4f6c447fd62371e979dd2fd4031c9a))
* **web:** say when the figures are the previous perf pass's ([#1040](https://github.com/pbrissaud/suivi-bourse/issues/1040)) ([5f70f0b](https://github.com/pbrissaud/suivi-bourse/commit/5f70f0bd184b4ce8c8905e4fa78d5f487aaa5144))
* **web:** say which currency a bracket ceiling is typed in ([#1045](https://github.com/pbrissaud/suivi-bourse/issues/1045)) ([4ec5e2d](https://github.com/pbrissaud/suivi-bourse/commit/4ec5e2ddc45ed7ea8aec537d7275dae6bae750d4))
* **web:** the Ticker field becomes a combobox of the titles the ledger names ([#1069](https://github.com/pbrissaud/suivi-bourse/issues/1069)) ([f77e1fd](https://github.com/pbrissaud/suivi-bourse/commit/f77e1fd6892c9cb417a397528dfbbdfc71a8badd))


### Bug Fixes

* **app:** store every symbol in one spelling, and refuse lookalikes ([#1093](https://github.com/pbrissaud/suivi-bourse/issues/1093)) ([3614643](https://github.com/pbrissaud/suivi-bourse/commit/36146431c330b3c6d906f805b9010d9a3a9b0471)), closes [#1068](https://github.com/pbrissaud/suivi-bourse/issues/1068)
* **benchmark:** confine the consulted list to the references still offered ([#1047](https://github.com/pbrissaud/suivi-bourse/issues/1047)) ([a784b1a](https://github.com/pbrissaud/suivi-bourse/commit/a784b1a05b8b2332839a7f167d4c0102ed9e89f8)), closes [#1034](https://github.com/pbrissaud/suivi-bourse/issues/1034)
* **benchmark:** end the comparison on the reference's last close ([#1052](https://github.com/pbrissaud/suivi-bourse/issues/1052)) ([6decb0d](https://github.com/pbrissaud/suivi-bourse/commit/6decb0d5280bf9d9a2967f934afeff3161fe6c2a))
* **benchmark:** publish each account over the head's own window ([#1039](https://github.com/pbrissaud/suivi-bourse/issues/1039)) ([0e8a161](https://github.com/pbrissaud/suivi-bourse/commit/0e8a1611b34e1f4b5dc1383b508ca121a69b5946))
* **benchmark:** seed each account on the first day its pot exists ([#1026](https://github.com/pbrissaud/suivi-bourse/issues/1026)) ([b68f049](https://github.com/pbrissaud/suivi-bourse/commit/b68f049ba62acfa6920cd929b70c34f2dddf9665))
* **benchmark:** seed the aggregate on the day it says it starts ([#1030](https://github.com/pbrissaud/suivi-bourse/issues/1030)) ([5a6178c](https://github.com/pbrissaud/suivi-bourse/commit/5a6178cf7bb9046301357aa2a99ed3615e7766b5))
* **benchmark:** the exclusion notice names the grant, not just the account ([f815eed](https://github.com/pbrissaud/suivi-bourse/commit/f815eede0191ae781804bc3eeddb44083da98de0))
* Change client ID to use secrets in release notes workflow ([e1da90d](https://github.com/pbrissaud/suivi-bourse/commit/e1da90da1241b911a7e59deb85e4531059e3e58d))
* **market:** file a daily bar under the day the exchange traded it ([#1016](https://github.com/pbrissaud/suivi-bourse/issues/1016)) ([8f3295d](https://github.com/pbrissaud/suivi-bourse/commit/8f3295d497b884434c0ef31a4314cf0211477c92)), closes [#1013](https://github.com/pbrissaud/suivi-bourse/issues/1013)
* **market:** store the close the market printed, not the one net of dividends ([#1010](https://github.com/pbrissaud/suivi-bourse/issues/1010)) ([f4ca3e3](https://github.com/pbrissaud/suivi-bourse/commit/f4ca3e3e99a62af48d02ea2a4ba4c189ccbb0f01))
* **performance:** count a priced grant in the contribution beside the P&L ([#1015](https://github.com/pbrissaud/suivi-bourse/issues/1015)) ([6200af0](https://github.com/pbrissaud/suivi-bourse/commit/6200af05059848eeca47b5066b152da2c04f6353)), closes [#1012](https://github.com/pbrissaud/suivi-bourse/issues/1012)
* **runtime:** name the pass that had nothing to write ([#1037](https://github.com/pbrissaud/suivi-bourse/issues/1037)) ([c0ac240](https://github.com/pbrissaud/suivi-bourse/commit/c0ac240e2a2337784a4c10145d91891b23ae472d))
* **web:** name the calendar the projected rate change lands on ([#1046](https://github.com/pbrissaud/suivi-bourse/issues/1046)) ([7cef14a](https://github.com/pbrissaud/suivi-bourse/commit/7cef14a744bdcdbaffec2b4397d18470fde5de9c)), closes [#952](https://github.com/pbrissaud/suivi-bourse/issues/952)
* **web:** offer the suggested grant price at the currency's precision ([#1038](https://github.com/pbrissaud/suivi-bourse/issues/1038)) ([a4ad903](https://github.com/pbrissaud/suivi-bourse/commit/a4ad903c08b10837622bae621e7cb68bd6b74496))
* **web:** put the dashboard head's value on the live gain's instant ([#1051](https://github.com/pbrissaud/suivi-bourse/issues/1051)) ([e734bfa](https://github.com/pbrissaud/suivi-bourse/commit/e734bfa42d4b9cb080250f60196f3b0ec9f99932))


### Dependencies

* **app:** update dependency urllib3 to v2.8.0 ([#997](https://github.com/pbrissaud/suivi-bourse/issues/997)) ([e7e08db](https://github.com/pbrissaud/suivi-bourse/commit/e7e08dbe5e1e3dff5077e8f642031ad6c11255b3))
* **app:** update dependency uvicorn to v0.54.0 ([#1071](https://github.com/pbrissaud/suivi-bourse/issues/1071)) ([872623b](https://github.com/pbrissaud/suivi-bourse/commit/872623bb2b7db523b4a580cc237f67dfd4736cf1))
* **repo:** update astral-sh/setup-uv action to v10.2.0 ([#1055](https://github.com/pbrissaud/suivi-bourse/issues/1055)) ([e2df85b](https://github.com/pbrissaud/suivi-bourse/commit/e2df85b861456c235689cfece6881b5c1bcd6907))
* **website:** update pnpm to v12.5.0 ([#1006](https://github.com/pbrissaud/suivi-bourse/issues/1006)) ([1163112](https://github.com/pbrissaud/suivi-bourse/commit/116311236fcc53948da35b374db9653c261adc77))
* **website:** update pnpm to v12.5.1 ([#1009](https://github.com/pbrissaud/suivi-bourse/issues/1009)) ([503bb5c](https://github.com/pbrissaud/suivi-bourse/commit/503bb5c730e6f24b29e697bca98108851e516a46))
* **website:** update pnpm to v12.6.0 ([#1061](https://github.com/pbrissaud/suivi-bourse/issues/1061)) ([1d5b992](https://github.com/pbrissaud/suivi-bourse/commit/1d5b992c8568ac0cf2c4518a329251fef421b761))
* **website:** update pnpm to v12.7.0 ([#1075](https://github.com/pbrissaud/suivi-bourse/issues/1075)) ([37f255d](https://github.com/pbrissaud/suivi-bourse/commit/37f255db5714737f8b6e046fec92b7d750db831c))
* **website:** update pnpm to v12.8.0 ([#1077](https://github.com/pbrissaud/suivi-bourse/issues/1077)) ([2d1a9e2](https://github.com/pbrissaud/suivi-bourse/commit/2d1a9e215eda02167ef1ac85e8050fd3414929af))
* **website:** update pnpm to v12.8.1 ([#1079](https://github.com/pbrissaud/suivi-bourse/issues/1079)) ([328e83f](https://github.com/pbrissaud/suivi-bourse/commit/328e83f687eb7a68cb4b4d088997ed4f52db9ba4))
* **website:** update pnpm to v12.8.2 ([#1083](https://github.com/pbrissaud/suivi-bourse/issues/1083)) ([59d3e39](https://github.com/pbrissaud/suivi-bourse/commit/59d3e396c0c1ac37e1701ee6bb3886e533980668))
* **website:** update pnpm to v12.9.0 ([#1088](https://github.com/pbrissaud/suivi-bourse/issues/1088)) ([068e1bf](https://github.com/pbrissaud/suivi-bourse/commit/068e1bf20638f74df990a40697caf63ffda55d8d))
* **website:** update pnpm to v12.9.1 ([#1090](https://github.com/pbrissaud/suivi-bourse/issues/1090)) ([2dfb0ec](https://github.com/pbrissaud/suivi-bourse/commit/2dfb0ecd9a25bdf200c7e2ee8bcda5bd4e84b293))
* **web:** update dependency @tanstack/react-query to v5.103.0 ([#998](https://github.com/pbrissaud/suivi-bourse/issues/998)) ([4dbd8ad](https://github.com/pbrissaud/suivi-bourse/commit/4dbd8adb43a574663c16dc2c98a025c6bbba3ede))
* **web:** update dependency @tanstack/react-query to v5.103.1 ([#999](https://github.com/pbrissaud/suivi-bourse/issues/999)) ([cd8b3d4](https://github.com/pbrissaud/suivi-bourse/commit/cd8b3d45fb6864ae1ce8cf3ca7fc0d573f00a062))
* **web:** update dependency @tanstack/react-query to v5.103.2 ([#1054](https://github.com/pbrissaud/suivi-bourse/issues/1054)) ([255f4a4](https://github.com/pbrissaud/suivi-bourse/commit/255f4a484734c5c3c2f0cc70d60a77c203f7f9aa))
* **web:** update dependency @tanstack/react-query to v5.103.3 ([#1072](https://github.com/pbrissaud/suivi-bourse/issues/1072)) ([c3da6da](https://github.com/pbrissaud/suivi-bourse/commit/c3da6dac04d5ca96834db5377538fc65a887f05a))
* **web:** update dependency @tanstack/react-query to v5.104.0 ([#1074](https://github.com/pbrissaud/suivi-bourse/issues/1074)) ([e0ed63d](https://github.com/pbrissaud/suivi-bourse/commit/e0ed63dbd075734ba7186cfa6c172b21e99cc246))
* **web:** update dependency @tanstack/react-query to v5.104.1 ([#1086](https://github.com/pbrissaud/suivi-bourse/issues/1086)) ([e2d8552](https://github.com/pbrissaud/suivi-bourse/commit/e2d8552e4cd077518f4ec47999f374a202aa4846))
* **web:** update dependency @tanstack/react-router to v1.170.38 ([#1000](https://github.com/pbrissaud/suivi-bourse/issues/1000)) ([94a6c92](https://github.com/pbrissaud/suivi-bourse/commit/94a6c9268bfc87c0003a1b227bc831760951b6a1))
* **web:** update dependency @tanstack/react-router to v1.170.39 ([#1062](https://github.com/pbrissaud/suivi-bourse/issues/1062)) ([2ced832](https://github.com/pbrissaud/suivi-bourse/commit/2ced832e1d5a8b51149cc67f1f4211d5ecd350e2))
* **web:** update dependency @tanstack/react-router to v1.170.40 ([#1076](https://github.com/pbrissaud/suivi-bourse/issues/1076)) ([4904fab](https://github.com/pbrissaud/suivi-bourse/commit/4904fabcceef21636e3aca0eb1f81efb5f840565))
* **web:** update dependency @tanstack/react-router to v1.170.41 ([#1082](https://github.com/pbrissaud/suivi-bourse/issues/1082)) ([1601384](https://github.com/pbrissaud/suivi-bourse/commit/1601384f54ceff93f0f90c04f1ade7da7bdcca24))
* **web:** update dependency @types/node to v26.6.0 ([#993](https://github.com/pbrissaud/suivi-bourse/issues/993)) ([89f7383](https://github.com/pbrissaud/suivi-bourse/commit/89f7383ad03fd7e7cbfcccab9e37f1b4d24492a8))
* **web:** update dependency @types/node to v26.6.1 ([#996](https://github.com/pbrissaud/suivi-bourse/issues/996)) ([c4a2d09](https://github.com/pbrissaud/suivi-bourse/commit/c4a2d09f0b6c3cd0ae8f78b31f559bff9384a3cd))
* **web:** update dependency @types/node to v26.6.2 ([#1011](https://github.com/pbrissaud/suivi-bourse/issues/1011)) ([348bc8d](https://github.com/pbrissaud/suivi-bourse/commit/348bc8dc3505fb3a100e72f2e26f4b19f6dc7962))
* **web:** update dependency @types/node to v26.6.3 ([#1073](https://github.com/pbrissaud/suivi-bourse/issues/1073)) ([d872517](https://github.com/pbrissaud/suivi-bourse/commit/d872517ae22910272975a465c02c0de5204977b2))
* **web:** update dependency @types/node to v26.6.4 ([#1085](https://github.com/pbrissaud/suivi-bourse/issues/1085)) ([f52f6a1](https://github.com/pbrissaud/suivi-bourse/commit/f52f6a153b6c67d1a776b3f6912fdf1a7cfbc9c5))
* **web:** update dependency intl-messageformat to v12.1.1 ([#1005](https://github.com/pbrissaud/suivi-bourse/issues/1005)) ([844f077](https://github.com/pbrissaud/suivi-bourse/commit/844f0774fa9cf8b664804e886d4ee5e353bb247a))
* **web:** update dependency intl-messageformat to v12.1.2 ([#1027](https://github.com/pbrissaud/suivi-bourse/issues/1027)) ([0e03a09](https://github.com/pbrissaud/suivi-bourse/commit/0e03a09738437de7e60097806aa26857cd99a285))
* **web:** update dependency jsdom to v30.1.0 ([#1001](https://github.com/pbrissaud/suivi-bourse/issues/1001)) ([8b34358](https://github.com/pbrissaud/suivi-bourse/commit/8b3435870a3d261eccc316f1cacbdfeccadf63c6))
* **web:** update dependency jsdom to v30.1.2 ([#1091](https://github.com/pbrissaud/suivi-bourse/issues/1091)) ([5426da0](https://github.com/pbrissaud/suivi-bourse/commit/5426da0c8569f6e9940a3b96a0fe6326374920d8))
* **web:** update dependency lucide-react to v1.47.0 ([#1002](https://github.com/pbrissaud/suivi-bourse/issues/1002)) ([f7104ae](https://github.com/pbrissaud/suivi-bourse/commit/f7104ae36be2607781e6946004955183267da160))
* **web:** update dependency lucide-react to v1.48.0 ([#1063](https://github.com/pbrissaud/suivi-bourse/issues/1063)) ([bf0a257](https://github.com/pbrissaud/suivi-bourse/commit/bf0a257ca00ebecb52003b0c0cbda78a0c5bc092))
* **web:** update dependency lucide-react to v1.49.0 ([#1080](https://github.com/pbrissaud/suivi-bourse/issues/1080)) ([97bb7ad](https://github.com/pbrissaud/suivi-bourse/commit/97bb7adf38f0135b9ca246085fd3cde63c0702e3))
* **web:** update dependency lucide-react to v1.50.0 ([#1087](https://github.com/pbrissaud/suivi-bourse/issues/1087)) ([cfd6239](https://github.com/pbrissaud/suivi-bourse/commit/cfd6239c0f6c27896eb1e0be7050e9a75f605e8d))
* **web:** update dependency lucide-react to v1.51.0 ([#1089](https://github.com/pbrissaud/suivi-bourse/issues/1089)) ([64a5385](https://github.com/pbrissaud/suivi-bourse/commit/64a538564af7ac858ccfff9e2f5d14ff9a854c66))
* **web:** update dependency lucide-react to v1.52.0 ([#1092](https://github.com/pbrissaud/suivi-bourse/issues/1092)) ([b366d3b](https://github.com/pbrissaud/suivi-bourse/commit/b366d3bc863baac450c3143b828989b9b7a2921d))
* **web:** update dependency msw to v3 ([#1078](https://github.com/pbrissaud/suivi-bourse/issues/1078)) ([e4c4bdf](https://github.com/pbrissaud/suivi-bourse/commit/e4c4bdf7fce3f77ecb6f14b23bd72f89aae91fe4))
* **web:** update dependency vite to v8.3.1 ([#1064](https://github.com/pbrissaud/suivi-bourse/issues/1064)) ([b02266a](https://github.com/pbrissaud/suivi-bourse/commit/b02266a84f6a29439958d3cdf142aec1e98b4849))
* **web:** update dependency vite to v8.3.2 ([#1084](https://github.com/pbrissaud/suivi-bourse/issues/1084)) ([6203d3d](https://github.com/pbrissaud/suivi-bourse/commit/6203d3db6a3038384dfffd1e845a5c8eed67ff51))
* **web:** update dependency vitest to v5.0.2 ([#1070](https://github.com/pbrissaud/suivi-bourse/issues/1070)) ([c73267f](https://github.com/pbrissaud/suivi-bourse/commit/c73267fa4ee799b94a508dcb9a80f5c0d27602c4))
* **web:** update dependency vitest to v5.0.3 ([#1081](https://github.com/pbrissaud/suivi-bourse/issues/1081)) ([cd595a3](https://github.com/pbrissaud/suivi-bourse/commit/cd595a3524063f35a044ddf45c5cd30056937d81))

## [5.1.2](https://github.com/pbrissaud/suivi-bourse/compare/v5.1.1...v5.1.2) (2026-09-18)


### Bug Fixes

* **market:** value a position in the share it was traded in ([#988](https://github.com/pbrissaud/suivi-bourse/issues/988)) ([f7020db](https://github.com/pbrissaud/suivi-bourse/commit/f7020db4138ff8a534ff0ce0a343bfbe4a510624)), closes [#987](https://github.com/pbrissaud/suivi-bourse/issues/987)


### Dependencies

* **web:** update dependency intl-messageformat to v12 ([#990](https://github.com/pbrissaud/suivi-bourse/issues/990)) ([35bbc93](https://github.com/pbrissaud/suivi-bourse/commit/35bbc934478ba9b815e78da262be08bd44c91b04))

## [5.1.1](https://github.com/pbrissaud/suivi-bourse/compare/v5.1.0...v5.1.1) (2026-09-18)


### Bug Fixes

* **entries:** write an import and a backfill in blocks, not row by row ([#984](https://github.com/pbrissaud/suivi-bourse/issues/984)) ([f095cd0](https://github.com/pbrissaud/suivi-bourse/commit/f095cd08120ef3757ac00b1b2819da2402de8961))
* **perf:** upsert the whole series in one statement, not one per row ([#980](https://github.com/pbrissaud/suivi-bourse/issues/980)) ([d4e2bee](https://github.com/pbrissaud/suivi-bourse/commit/d4e2bee5acab8ee8a936e95f9ac595d6fc69a765))


### Dependencies

* **website:** update pnpm to v12.4.2 ([#985](https://github.com/pbrissaud/suivi-bourse/issues/985)) ([04a2e35](https://github.com/pbrissaud/suivi-bourse/commit/04a2e35823cd82a0a5f4b51e92f79fd619f0f6fc))
* **web:** update dependency vitest to v5 ([#904](https://github.com/pbrissaud/suivi-bourse/issues/904)) ([52a81ee](https://github.com/pbrissaud/suivi-bourse/commit/52a81ee2676a3d227096db7c01169adc01b76102))

## [5.1.0](https://github.com/pbrissaud/suivi-bourse/compare/v5.0.0...v5.1.0) (2026-09-17)


### Features

* **accounts:** the account type stops being a question ([#916](https://github.com/pbrissaud/suivi-bourse/issues/916)) ([#928](https://github.com/pbrissaud/suivi-bourse/issues/928)) ([38ed210](https://github.com/pbrissaud/suivi-bourse/commit/38ed210cdf8f26d90899d81d6747b58f729fa722))
* **app:** the investment rhythm, measured on the buys ([#751](https://github.com/pbrissaud/suivi-bourse/issues/751)) ([#896](https://github.com/pbrissaud/suivi-bourse/issues/896)) ([da52d7d](https://github.com/pbrissaud/suivi-bourse/commit/da52d7d501f69dd52cf62fb4b56e38591fd103b7))
* **dashboard:** the rhythm draws its twelve months ([#906](https://github.com/pbrissaud/suivi-bourse/issues/906)) ([798f33e](https://github.com/pbrissaud/suivi-bourse/commit/798f33e19d8763691596ac0a8aa62a97b4249d12))
* **market:** include sector, industry, and country classifications ([#966](https://github.com/pbrissaud/suivi-bourse/issues/966)) ([93f971a](https://github.com/pbrissaud/suivi-bourse/commit/93f971a5fe6217b9c867620c3a7a699ecd915f49))
* **mcp:** a read-only MCP server exposing the portfolio ([#877](https://github.com/pbrissaud/suivi-bourse/issues/877)) ([90de760](https://github.com/pbrissaud/suivi-bourse/commit/90de7607cfdfd9325debe1286e8e7804a50a5219))
* **mcp:** the agent reads the account the panel reads, and the perimeter it is drawn from ([#955](https://github.com/pbrissaud/suivi-bourse/issues/955)) ([1973e73](https://github.com/pbrissaud/suivi-bourse/commit/1973e732949280bb16a9cfbb2abb993b8fc46177))
* **store:** the store learns what generation it is, and drops account.type ([#926](https://github.com/pbrissaud/suivi-bourse/issues/926)) ([#946](https://github.com/pbrissaud/suivi-bourse/issues/946)) ([bb9c8f5](https://github.com/pbrissaud/suivi-bourse/commit/bb9c8f58fb5862d18461e089b202943874ff5f84))
* **taxation:** a taxation model per account, and the two tables it lives in ([#752](https://github.com/pbrissaud/suivi-bourse/issues/752)) ([#930](https://github.com/pbrissaud/suivi-bourse/issues/930)) ([140fd23](https://github.com/pbrissaud/suivi-bourse/commit/140fd237a7c04733fd5d6005bef58385c017eed9))
* **taxation:** an account carries a declared opening date, pre-filled and contradicted out loud ([#918](https://github.com/pbrissaud/suivi-bourse/issues/918)) ([#935](https://github.com/pbrissaud/suivi-bourse/issues/935)) ([8dce7cd](https://github.com/pbrissaud/suivi-bourse/commit/8dce7cdb94dc223ad182041da64ed300e4553262))
* **taxation:** an account says what it would owe if it were emptied today ([#948](https://github.com/pbrissaud/suivi-bourse/issues/948)) ([ebc5912](https://github.com/pbrissaud/suivi-bourse/commit/ebc59120761f4e0c243da1f17b8359af4a2800e6))


### Bug Fixes

* **accounts:** an opening date still to come is contradicted out loud ([#973](https://github.com/pbrissaud/suivi-bourse/issues/973)) ([55a5116](https://github.com/pbrissaud/suivi-bourse/commit/55a51165167b401db323889e427b3c4ca5dc27e0))
* **api:** a refusal by design is neither fault ([#856](https://github.com/pbrissaud/suivi-bourse/issues/856)) ([#913](https://github.com/pbrissaud/suivi-bourse/issues/913)) ([d4a300a](https://github.com/pbrissaud/suivi-bourse/commit/d4a300a83d89a9866a8aa1775b33432a33b057e7))
* **api:** a refusal werkzeug decided is no longer a fault on the wire ([#975](https://github.com/pbrissaud/suivi-bourse/issues/975)) ([cade0b5](https://github.com/pbrissaud/suivi-bourse/commit/cade0b5e98444acc362b4dd580f355682cc8def1))
* **backfill:** a failed write does not move the anchor ([#853](https://github.com/pbrissaud/suivi-bourse/issues/853)) ([#909](https://github.com/pbrissaud/suivi-bourse/issues/909)) ([8bf7df5](https://github.com/pbrissaud/suivi-bourse/commit/8bf7df54107860b5a80f7d720af3856267d39350))
* **backfill:** the forward pass stops asking Yahoo for a weekend that cannot answer ([#960](https://github.com/pbrissaud/suivi-bourse/issues/960)) ([575e933](https://github.com/pbrissaud/suivi-bourse/commit/575e9330787b7faf57d49cc4d5f4d2b3f9515a04)), closes [#854](https://github.com/pbrissaud/suivi-bourse/issues/854)
* **boot:** the guard gives the store back whatever fails after the open ([#961](https://github.com/pbrissaud/suivi-bourse/issues/961)) ([fbe8d61](https://github.com/pbrissaud/suivi-bourse/commit/fbe8d614c99136b80cd80597081d1f9f5bb78bb2)), closes [#857](https://github.com/pbrissaud/suivi-bourse/issues/857)
* **fx:** a failed fetch no longer answers None for the whole TTL ([#963](https://github.com/pbrissaud/suivi-bourse/issues/963)) ([4eeb85d](https://github.com/pbrissaud/suivi-bourse/commit/4eeb85dc16a6f2613245c16338c97daacc6aae4b))
* **market:** classify a symbol the live scrape will not fetch again ([#974](https://github.com/pbrissaud/suivi-bourse/issues/974)) ([61a458f](https://github.com/pbrissaud/suivi-bourse/commit/61a458f119ee8d4b5311f31c89542185067b0ecc)), closes [#968](https://github.com/pbrissaud/suivi-bourse/issues/968)
* **scrape:** the re-arm is the last thing that puts a symbol back ([#855](https://github.com/pbrissaud/suivi-bourse/issues/855)) ([#914](https://github.com/pbrissaud/suivi-bourse/issues/914)) ([0d13008](https://github.com/pbrissaud/suivi-bourse/commit/0d13008d750848f29f2c1334586c1e455a42aaf0))
* **shares:** the valuation column stops painting every held row as a gain ([#957](https://github.com/pbrissaud/suivi-bourse/issues/957)) ([3125d8b](https://github.com/pbrissaud/suivi-bourse/commit/3125d8b0c8b9f73bffd6c68504e8499c49dc802e))
* **store:** a deleted key is never handed to the next writer ([#785](https://github.com/pbrissaud/suivi-bourse/issues/785)) ([#908](https://github.com/pbrissaud/suivi-bourse/issues/908)) ([de6e0d4](https://github.com/pbrissaud/suivi-bourse/commit/de6e0d4124368de6c177ba7a27a3150190418081))
* **store:** a read after the shutdown says the store is closed ([#962](https://github.com/pbrissaud/suivi-bourse/issues/962)) ([0538f7d](https://github.com/pbrissaud/suivi-bourse/commit/0538f7d086c363e03b517caeada833da47f51598)), closes [#858](https://github.com/pbrissaud/suivi-bourse/issues/858)
* **store:** the API reads through a connection of its own ([#977](https://github.com/pbrissaud/suivi-bourse/issues/977)) ([cacdf8c](https://github.com/pbrissaud/suivi-bourse/commit/cacdf8c5d9bf9037285c83e0063c4bf712c3fab2)), closes [#967](https://github.com/pbrissaud/suivi-bourse/issues/967)
* **taxation:** the projection card names the gain its rate was applied to ([1b6a9b1](https://github.com/pbrissaud/suivi-bourse/commit/1b6a9b100343ee54ed1bc40c95b95763319423c1))
* the eleven findings of the preview/v5 review ([#861](https://github.com/pbrissaud/suivi-bourse/issues/861)) ([#912](https://github.com/pbrissaud/suivi-bourse/issues/912)) ([45cc57b](https://github.com/pbrissaud/suivi-bourse/commit/45cc57bd743c426f29f8afcd1f422222ca90df97))
* **web:** the head of an account divides the gain the rail divides ([#976](https://github.com/pbrissaud/suivi-bourse/issues/976)) ([b36bfcf](https://github.com/pbrissaud/suivi-bourse/commit/b36bfcfe9eb6eff051cdd6e360bf12f9ae5c7c05))
* **web:** the same dash is the same grey ([#860](https://github.com/pbrissaud/suivi-bourse/issues/860)) ([#911](https://github.com/pbrissaud/suivi-bourse/issues/911)) ([1a21883](https://github.com/pbrissaud/suivi-bourse/commit/1a2188354a515fe0074f3d7dc6fc90cd0f69a8bf))
* **web:** unblock the image build after a same-day lucide-react bump ([#885](https://github.com/pbrissaud/suivi-bourse/issues/885)) ([3af6af1](https://github.com/pbrissaud/suivi-bourse/commit/3af6af1f06eb24fd3880c5c5c9df1f3c4e95f1da))


### Dependencies

* **app:** update dependency uvicorn to v0.53.0 ([#978](https://github.com/pbrissaud/suivi-bourse/issues/978)) ([d74d335](https://github.com/pbrissaud/suivi-bourse/commit/d74d335ddbd311e8621309014eb9119f49dcf3af))
* **app:** update dependency yfinance to v1.7.0 ([#880](https://github.com/pbrissaud/suivi-bourse/issues/880)) ([541b0c0](https://github.com/pbrissaud/suivi-bourse/commit/541b0c03b1b3388b151ba6a8d2dc5fc7a54cf051))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.12.8 ([#876](https://github.com/pbrissaud/suivi-bourse/issues/876)) ([a29f98d](https://github.com/pbrissaud/suivi-bourse/commit/a29f98d06b44e721f5f235f59a69bb492f5bb4d2))
* **repo:** update astral-sh/setup-uv action to v10.1.0 ([#944](https://github.com/pbrissaud/suivi-bourse/issues/944)) ([362c7b0](https://github.com/pbrissaud/suivi-bourse/commit/362c7b0c51672598eb25403ca2049a7f697d88cd))
* **website:** update pnpm to v11.25.0 ([#892](https://github.com/pbrissaud/suivi-bourse/issues/892)) ([f0fb251](https://github.com/pbrissaud/suivi-bourse/commit/f0fb251dfeb9636980c8b83c0c3839dae621f79e))
* **website:** update pnpm to v11.26.0 ([#924](https://github.com/pbrissaud/suivi-bourse/issues/924)) ([51313b7](https://github.com/pbrissaud/suivi-bourse/commit/51313b72f2c8ba9463789b937967318b12ff3f70))
* **website:** update pnpm to v12 ([#901](https://github.com/pbrissaud/suivi-bourse/issues/901)) ([a759313](https://github.com/pbrissaud/suivi-bourse/commit/a759313308bbb28e61c386878a38943cd9f63a53))
* **website:** update pnpm to v12.4.1 ([#942](https://github.com/pbrissaud/suivi-bourse/issues/942)) ([29cdb49](https://github.com/pbrissaud/suivi-bourse/commit/29cdb49a420287ab0a9e44a8d60d22886bae0fa2))
* **website:** update react monorepo to v19.3.0 ([#936](https://github.com/pbrissaud/suivi-bourse/issues/936)) ([6db560c](https://github.com/pbrissaud/suivi-bourse/commit/6db560cb754ce1a0515ca1d60c3102aa3fbdc04e))
* **web:** update dependency @tanstack/react-query to v5.102.8 ([#881](https://github.com/pbrissaud/suivi-bourse/issues/881)) ([c524ce2](https://github.com/pbrissaud/suivi-bourse/commit/c524ce2eca136e81ff10e0c1216cb0ea929fcdc0))
* **web:** update dependency @tanstack/react-router to v1.170.33 ([#923](https://github.com/pbrissaud/suivi-bourse/issues/923)) ([871b6d9](https://github.com/pbrissaud/suivi-bourse/commit/871b6d99c7d6e2c3645d3351ceea9bb4dde25339))
* **web:** update dependency @tanstack/react-router to v1.170.34 ([#939](https://github.com/pbrissaud/suivi-bourse/issues/939)) ([a334e53](https://github.com/pbrissaud/suivi-bourse/commit/a334e53ba13927055e14f1293c6dc2c237f416b9))
* **web:** update dependency @tanstack/react-router to v1.170.35 ([#943](https://github.com/pbrissaud/suivi-bourse/issues/943)) ([7139a5d](https://github.com/pbrissaud/suivi-bourse/commit/7139a5d1ed491d3f4a27c517d28f2ca20bac8598))
* **web:** update dependency @tanstack/react-router to v1.170.36 ([#959](https://github.com/pbrissaud/suivi-bourse/issues/959)) ([9f1782e](https://github.com/pbrissaud/suivi-bourse/commit/9f1782ecdafdeb6ad589f4da083664659078e771))
* **web:** update dependency @testing-library/user-event to v14.6.7 ([#900](https://github.com/pbrissaud/suivi-bourse/issues/900)) ([30cc625](https://github.com/pbrissaud/suivi-bourse/commit/30cc6258253c0f9786e7c4c80a25a9551743ed47))
* **web:** update dependency @types/node to v26.4.0 ([#882](https://github.com/pbrissaud/suivi-bourse/issues/882)) ([6b537be](https://github.com/pbrissaud/suivi-bourse/commit/6b537be536a36122ef0a35a89f1c3bfb6c99c3c9))
* **web:** update dependency @types/node to v26.4.1 ([#899](https://github.com/pbrissaud/suivi-bourse/issues/899)) ([0be8a5e](https://github.com/pbrissaud/suivi-bourse/commit/0be8a5e98326d9621832a50f30c249c22715480c))
* **web:** update dependency @types/node to v26.5.0 ([#925](https://github.com/pbrissaud/suivi-bourse/issues/925)) ([52c77b8](https://github.com/pbrissaud/suivi-bourse/commit/52c77b802f131cc33e4866e4f0d8844f71f9699a))
* **web:** update dependency @types/node to v26.5.1 ([#937](https://github.com/pbrissaud/suivi-bourse/issues/937)) ([2138940](https://github.com/pbrissaud/suivi-bourse/commit/2138940df64a5f462e4270835775979948b4cd96))
* **web:** update dependency @types/react-dom to v19.2.6 ([#902](https://github.com/pbrissaud/suivi-bourse/issues/902)) ([48592c2](https://github.com/pbrissaud/suivi-bourse/commit/48592c26e06500ee1c5f600be9951eefa429cd81))
* **web:** update dependency @types/react-dom to v19.2.7 ([#903](https://github.com/pbrissaud/suivi-bourse/issues/903)) ([e169257](https://github.com/pbrissaud/suivi-bourse/commit/e169257c0db1e665637c4d1a7a66025baf47c5fc))
* **web:** update dependency @vitejs/plugin-react to v6.1.1 ([#883](https://github.com/pbrissaud/suivi-bourse/issues/883)) ([f9fc1fd](https://github.com/pbrissaud/suivi-bourse/commit/f9fc1fd036b39b701820e89e9d05cdfb1478fcb7))
* **web:** update dependency intl-messageformat to v11.2.14 ([#870](https://github.com/pbrissaud/suivi-bourse/issues/870)) ([f2e11be](https://github.com/pbrissaud/suivi-bourse/commit/f2e11be35e62651e36c8c71ad3393c27b5353241))
* **web:** update dependency intl-messageformat to v11.2.15 ([#949](https://github.com/pbrissaud/suivi-bourse/issues/949)) ([15be9ec](https://github.com/pbrissaud/suivi-bourse/commit/15be9ecb80c6f0aba962508ed0588e494f7f9e8e))
* **web:** update dependency lucide-react to v1.37.0 ([#891](https://github.com/pbrissaud/suivi-bourse/issues/891)) ([fe448a5](https://github.com/pbrissaud/suivi-bourse/commit/fe448a53ec262f755e26cd53978d2d79de7d6527))
* **web:** update dependency lucide-react to v1.38.0 ([#897](https://github.com/pbrissaud/suivi-bourse/issues/897)) ([25a467a](https://github.com/pbrissaud/suivi-bourse/commit/25a467a658fbfedb4f8881ca5e6969d7902fac87))
* **web:** update dependency lucide-react to v1.39.0 ([#884](https://github.com/pbrissaud/suivi-bourse/issues/884)) ([fe3f549](https://github.com/pbrissaud/suivi-bourse/commit/fe3f5495a68e288636730a2d3bf949bd3267d28d))
* **web:** update dependency lucide-react to v1.40.0 ([#898](https://github.com/pbrissaud/suivi-bourse/issues/898)) ([ad5b0f5](https://github.com/pbrissaud/suivi-bourse/commit/ad5b0f52279a27baf5ad1dbeb6e5db17640515d2))
* **web:** update dependency lucide-react to v1.44.0 ([#940](https://github.com/pbrissaud/suivi-bourse/issues/940)) ([d65a059](https://github.com/pbrissaud/suivi-bourse/commit/d65a05970c956484805e2db3ae84034db33862b3))
* **web:** update dependency lucide-react to v1.45.0 ([#945](https://github.com/pbrissaud/suivi-bourse/issues/945)) ([371175c](https://github.com/pbrissaud/suivi-bourse/commit/371175c9bc52947fb264fa2800f4218404cb492f))
* **web:** update dependency lucide-react to v1.46.0 ([#979](https://github.com/pbrissaud/suivi-bourse/issues/979)) ([7ba14e0](https://github.com/pbrissaud/suivi-bourse/commit/7ba14e01286c273a2ac258768c9029062be4c461))
* **web:** update dependency tailwind-merge to v3.7.0 ([#950](https://github.com/pbrissaud/suivi-bourse/issues/950)) ([92ae354](https://github.com/pbrissaud/suivi-bourse/commit/92ae3549472d8c544a0d54f18a5e0ccc25e6def4))
* **web:** update dependency vite to v8.2.2 ([#871](https://github.com/pbrissaud/suivi-bourse/issues/871)) ([7b7531d](https://github.com/pbrissaud/suivi-bourse/commit/7b7531d2e3d3350f442df07634e9aec48d1a9ff6))
* **web:** update dependency vite to v8.3.0 ([#941](https://github.com/pbrissaud/suivi-bourse/issues/941)) ([f9bc095](https://github.com/pbrissaud/suivi-bourse/commit/f9bc095786832a929d3bce68c7d874ca88a3216f))
* **web:** update dependency vitest to v4.1.11 ([#878](https://github.com/pbrissaud/suivi-bourse/issues/878)) ([ae54032](https://github.com/pbrissaud/suivi-bourse/commit/ae54032cf25106b11e4d9dfd6f92f1e6f497f5f0))
* **web:** update react monorepo to v19.3.0 ([#938](https://github.com/pbrissaud/suivi-bourse/issues/938)) ([39c912c](https://github.com/pbrissaud/suivi-bourse/commit/39c912ccd5d62bc5df6bd3aee1758b3610b4e3e1))
* **web:** update testing-library monorepo ([#879](https://github.com/pbrissaud/suivi-bourse/issues/879)) ([0674c55](https://github.com/pbrissaud/suivi-bourse/commit/0674c553044e5c4eb2f7594917bc3fc8ee0269bd))

## [5.0.0](https://github.com/pbrissaud/suivi-bourse/compare/v4.2.2...v5.0.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **app:** SuiviBourse 5.0 — one embedded store, one interface, one container ([#866](https://github.com/pbrissaud/suivi-bourse/issues/866))

### Features

* **app:** SuiviBourse 5.0 — one embedded store, one interface, one container ([#866](https://github.com/pbrissaud/suivi-bourse/issues/866)) ([0a677ef](https://github.com/pbrissaud/suivi-bourse/commit/0a677ef22a2bb21fdf8b73581f26031823eb6bd1))


### What this release actually is

Version 5 is a rewrite and it arrived as one squashed commit, so the line above
is the whole of what this file can generate about it. **The hand-written account
is the one to read**:
[Release notes](https://pbrissaud.github.io/suivi-bourse/docs/v5/release-notes)
for what changed and what to watch out for, and
[Coming from version 4](https://pbrissaud.github.io/suivi-bourse/docs/v5/coming-from-v4)
for the crossing itself. The 614 commits of the rewrite are on the `preview/v5`
branch and in [#866](https://github.com/pbrissaud/suivi-bourse/pull/866).


### Dependencies

Renovate kept bumping version 4's files while the rewrite was in flight, and
version 5 deletes those files — so a generated list here would mostly describe a
tree this release removes. What 5.0.0 **ships**:

* `yfinance==1.5.2`, pinned exactly. Deliberately not the 1.7.0 that version 4's
  `app/pyproject.toml` reached: it is the product's single door to the market and
  the test suite fakes it, so that bump is its own change with its own check.
* `ghcr.io/astral-sh/uv:0.12.7` in the image
  ([#682](https://github.com/pbrissaud/suivi-bourse/issues/682) …
  [#840](https://github.com/pbrissaud/suivi-bourse/issues/840), carried over to
  the rewrite's own `Dockerfile`).
* `pnpm@11.24.0`
  ([#747](https://github.com/pbrissaud/suivi-bourse/issues/747),
  [#779](https://github.com/pbrissaud/suivi-bourse/issues/779),
  [#805](https://github.com/pbrissaud/suivi-bourse/issues/805),
  [#827](https://github.com/pbrissaud/suivi-bourse/issues/827)) and
  `astral-sh/setup-uv@v10.0.1`
  ([#767](https://github.com/pbrissaud/suivi-bourse/issues/767)).

Grafana and InfluxDB carry no version here any more: version 5 does not ship
them.


## [4.2.2](https://github.com/pbrissaud/suivi-bourse/compare/v4.2.1...v4.2.2) (2026-08-04)


### Bug Fixes

* **docker-compose:** authenticate the InfluxDB healthcheck ([#644](https://github.com/pbrissaud/suivi-bourse/issues/644)) ([3750054](https://github.com/pbrissaud/suivi-bourse/commit/375005445b28484f4662d2f4dfcae1c78624e82e))


### Dependencies

* **docker-compose:** update grafana/grafana docker tag to v13.1.2 ([#643](https://github.com/pbrissaud/suivi-bourse/issues/643)) ([b8bd7ae](https://github.com/pbrissaud/suivi-bourse/commit/b8bd7ae3c979495e79e8cbdd29b4e8256391bda9))

## [4.2.1](https://github.com/pbrissaud/suivi-bourse/compare/v4.2.0...v4.2.1) (2026-08-04)


### Bug Fixes

* **compose:** separate port publishing into an optional overlay ([#641](https://github.com/pbrissaud/suivi-bourse/issues/641)) ([062e92c](https://github.com/pbrissaud/suivi-bourse/commit/062e92cc485cc44c0e4dcd0d9bc50969d54128e6))

## [4.2.0](https://github.com/pbrissaud/suivi-bourse/compare/v4.1.0...v4.2.0) (2026-08-04)


### Features

* **docker-compose:** make the deployment config-driven ([#638](https://github.com/pbrissaud/suivi-bourse/issues/638)) ([ed0c4a1](https://github.com/pbrissaud/suivi-bourse/commit/ed0c4a147c24eaa734eebdf31dc5d4b955adddac))


### Documentation

* document deploying the compose stack on Coolify ([#639](https://github.com/pbrissaud/suivi-bourse/issues/639)) ([e8915f6](https://github.com/pbrissaud/suivi-bourse/commit/e8915f61839ac27cb349f14ebbc6958f39f159ff))
* **website:** changelog section for v4.2 ([#640](https://github.com/pbrissaud/suivi-bourse/issues/640)) ([820245d](https://github.com/pbrissaud/suivi-bourse/commit/820245d969182a47b49ecddc05eca6f52637c5a7))


### Dependencies

* **website:** update pnpm to v11.20.0 ([#636](https://github.com/pbrissaud/suivi-bourse/issues/636)) ([2e4b833](https://github.com/pbrissaud/suivi-bourse/commit/2e4b833193eeb15c4deea94fc8d056329d66cb69))

## [4.1.0](https://github.com/pbrissaud/suivi-bourse/compare/v4.0.1...v4.1.0) (2026-08-03)


### Features

* **app:** cash events, per-account ledger & account_metrics ([#576](https://github.com/pbrissaud/suivi-bourse/issues/576)) ([#589](https://github.com/pbrissaud/suivi-bourse/issues/589)) ([b696ad0](https://github.com/pbrissaud/suivi-bourse/commit/b696ad019181b263c3aa075f90fc18255425223f))
* **app:** consecutive-failure backoff dead-ticker guard ([#617](https://github.com/pbrissaud/suivi-bourse/issues/617)) ([#622](https://github.com/pbrissaud/suivi-bourse/issues/622)) ([f1cd6ea](https://github.com/pbrissaud/suivi-bourse/commit/f1cd6ea9bdbb1c749596dcf23e421926cbff9281))
* **app:** executor pool sizing, anti-herd jitter & misfire policy ([#619](https://github.com/pbrissaud/suivi-bourse/issues/619)) ([#624](https://github.com/pbrissaud/suivi-bourse/issues/624)) ([7842229](https://github.com/pbrissaud/suivi-bourse/commit/7842229c23aad8561a164c9189f0d690c4419502))
* **app:** first-class accounts ([#574](https://github.com/pbrissaud/suivi-bourse/issues/574)) ([#586](https://github.com/pbrissaud/suivi-bourse/issues/586)) ([8f4ced5](https://github.com/pbrissaud/suivi-bourse/commit/8f4ced590bf7ec52c047691162cc216c777f7f54))
* **app:** forward gap-fill backfill pass for missed sessions ([#627](https://github.com/pbrissaud/suivi-bourse/issues/627)) ([#629](https://github.com/pbrissaud/suivi-bourse/issues/629)) ([9c6700f](https://github.com/pbrissaud/suivi-bourse/commit/9c6700fb65f5054a979c2ac00920dae358d897c9))
* **app:** market-aware per-symbol scheduling ([#616](https://github.com/pbrissaud/suivi-bourse/issues/616)) ([#621](https://github.com/pbrissaud/suivi-bourse/issues/621)) ([6531181](https://github.com/pbrissaud/suivi-bourse/commit/6531181805a3e1553b12747edffbaad7280ddb3b))
* **app:** money-weighted performance — XIRR, TWR & portfolio_totals ([#577](https://github.com/pbrissaud/suivi-bourse/issues/577)) ([#591](https://github.com/pbrissaud/suivi-bourse/issues/591)) ([1f1f265](https://github.com/pbrissaud/suivi-bourse/commit/1f1f2652fc7010e62447d5b87bef49fbb0d94de5))
* **app:** perf recompute as its own gated interval job ([#618](https://github.com/pbrissaud/suivi-bourse/issues/618)) ([#623](https://github.com/pbrissaud/suivi-bourse/issues/623)) ([c4ff26a](https://github.com/pbrissaud/suivi-bourse/commit/c4ff26a7018d579af92eea1adcb80f2768b164c6))
* **app:** price-freshness liveness sonde ([#628](https://github.com/pbrissaud/suivi-bourse/issues/628)) ([#630](https://github.com/pbrissaud/suivi-bourse/issues/630)) ([cf40760](https://github.com/pbrissaud/suivi-bourse/commit/cf40760824e5a1fdb07abb308e2098afc2be2766))
* **app:** Timeline replay aggregation ([#575](https://github.com/pbrissaud/suivi-bourse/issues/575)) ([#587](https://github.com/pbrissaud/suivi-bourse/issues/587)) ([516c14f](https://github.com/pbrissaud/suivi-bourse/commit/516c14fb666f9da2eb20f46c3424a4485fd14f60))


### Bug Fixes

* **app:** use last non-NaN close in _fetch_ticker_data ([088d31e](https://github.com/pbrissaud/suivi-bourse/commit/088d31e3505f3d8b7ebeceb499df6b6e74b39a41))
* **app:** write perf series incrementally to stop Parquet fragmentation ([ab7493e](https://github.com/pbrissaud/suivi-bourse/commit/ab7493e479b73310dfeff6f269e7ee067b928fe2)), closes [#597](https://github.com/pbrissaud/suivi-bourse/issues/597)


### Documentation

* **website:** add a guide on reading the Accounts dashboard metrics ([#594](https://github.com/pbrissaud/suivi-bourse/issues/594)) ([6548da3](https://github.com/pbrissaud/suivi-bourse/commit/6548da32dd4737144285103e2e8272924e1e8a51))
* **website:** bidirectional backfill, freshness sonde & changelog page ([#626](https://github.com/pbrissaud/suivi-bourse/issues/626)) ([#635](https://github.com/pbrissaud/suivi-bourse/issues/635)) ([c215575](https://github.com/pbrissaud/suivi-bourse/commit/c2155757a9a979d01b886f4afaaf90d4de0a4ced))
* **website:** document market-aware scraping & rollout framing ([#620](https://github.com/pbrissaud/suivi-bourse/issues/620)) ([#625](https://github.com/pbrissaud/suivi-bourse/issues/625)) ([3f6a72b](https://github.com/pbrissaud/suivi-bourse/commit/3f6a72b8f55cb6922d2d9dac29e3bac5e67e26a7))
* **website:** document the account-tag migration seam and manual purge ([#578](https://github.com/pbrissaud/suivi-bourse/issues/578)) ([#593](https://github.com/pbrissaud/suivi-bourse/issues/593)) ([cb7e49f](https://github.com/pbrissaud/suivi-bourse/commit/cb7e49fcb4661804e69163867f6912f3a2269cd8))


### Dependencies

* **app:** update dependency confuse to v2.2.1 ([#584](https://github.com/pbrissaud/suivi-bourse/issues/584)) ([f3bb9c6](https://github.com/pbrissaud/suivi-bourse/commit/f3bb9c6a32b46f616eae8ddb9141395ed2a6986c))
* **app:** update dependency prometheus-client to v0.26.0 ([#613](https://github.com/pbrissaud/suivi-bourse/issues/613)) ([81c87c2](https://github.com/pbrissaud/suivi-bourse/commit/81c87c24ac907f391f4a1e2720f7cfc2c3575185))
* **app:** update dependency yfinance to v1.5.2 ([#600](https://github.com/pbrissaud/suivi-bourse/issues/600)) ([ff3d690](https://github.com/pbrissaud/suivi-bourse/commit/ff3d6909a05a1b8c1f4712da315ce78a14b121c3))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.29 ([#580](https://github.com/pbrissaud/suivi-bourse/issues/580)) ([2bc212a](https://github.com/pbrissaud/suivi-bourse/commit/2bc212aa39aad98c1f9af8f118d38f9ce5e9cea1))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.30 ([#588](https://github.com/pbrissaud/suivi-bourse/issues/588)) ([0bbce9c](https://github.com/pbrissaud/suivi-bourse/commit/0bbce9c9efdcb3d8c1c1824edd758e616f017d64))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.31 ([#598](https://github.com/pbrissaud/suivi-bourse/issues/598)) ([c0f5cef](https://github.com/pbrissaud/suivi-bourse/commit/c0f5cef0daa9ba836d432771bb1da4d32ec7e38e))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.32 ([#610](https://github.com/pbrissaud/suivi-bourse/issues/610)) ([5401754](https://github.com/pbrissaud/suivi-bourse/commit/5401754fa6b2ce9d595e1243ca4d70502511f4cb))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.33 ([#631](https://github.com/pbrissaud/suivi-bourse/issues/631)) ([b40431b](https://github.com/pbrissaud/suivi-bourse/commit/b40431b6e122f336f647ed888545f056f8adebd0))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.12.0 ([#632](https://github.com/pbrissaud/suivi-bourse/issues/632)) ([07899d1](https://github.com/pbrissaud/suivi-bourse/commit/07899d14d36086fad146f22682697f049186fe15))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.12.1 ([#634](https://github.com/pbrissaud/suivi-bourse/issues/634)) ([d9f929c](https://github.com/pbrissaud/suivi-bourse/commit/d9f929c2fcb77badafc3463b2d5ebb5061877493))
* **docker-compose:** update grafana/grafana docker tag to v13.1.1 ([#590](https://github.com/pbrissaud/suivi-bourse/issues/590)) ([57d0062](https://github.com/pbrissaud/suivi-bourse/commit/57d00628d28f8fb184e6b8031e71310c94e25f48))
* **website:** update docusaurus monorepo to v3.10.2 ([#552](https://github.com/pbrissaud/suivi-bourse/issues/552)) ([92d05ce](https://github.com/pbrissaud/suivi-bourse/commit/92d05cef0d547b43995b7080fdaa8263606a447d))
* **website:** update pnpm to v11.12.0 ([#567](https://github.com/pbrissaud/suivi-bourse/issues/567)) ([58bcbac](https://github.com/pbrissaud/suivi-bourse/commit/58bcbac492e7eac18e8e162e6a8723365d7a08d0))
* **website:** update pnpm to v11.13.0 ([#573](https://github.com/pbrissaud/suivi-bourse/issues/573)) ([dd0a57b](https://github.com/pbrissaud/suivi-bourse/commit/dd0a57bc4d06ae531b1928c7529d96148c8288bc))
* **website:** update pnpm to v11.13.1 ([#581](https://github.com/pbrissaud/suivi-bourse/issues/581)) ([de831e9](https://github.com/pbrissaud/suivi-bourse/commit/de831e9dd4bd79caf604df342863a66751842cdc))
* **website:** update pnpm to v11.14.0 ([#582](https://github.com/pbrissaud/suivi-bourse/issues/582)) ([61976b5](https://github.com/pbrissaud/suivi-bourse/commit/61976b5ba7bc7d1513a76eac153d58ea32776dd8))
* **website:** update pnpm to v11.15.0 ([#583](https://github.com/pbrissaud/suivi-bourse/issues/583)) ([2780a5e](https://github.com/pbrissaud/suivi-bourse/commit/2780a5e369fbfcb7bed3c6c508ab4d228f633dc7))
* **website:** update pnpm to v11.15.1 ([#585](https://github.com/pbrissaud/suivi-bourse/issues/585)) ([f112980](https://github.com/pbrissaud/suivi-bourse/commit/f1129802597794f8278f85593e23c5637549b029))
* **website:** update pnpm to v11.16.0 ([#599](https://github.com/pbrissaud/suivi-bourse/issues/599)) ([593ef53](https://github.com/pbrissaud/suivi-bourse/commit/593ef53d014efa7d0d1ccd69d8e0c602ed85af78))
* **website:** update pnpm to v11.17.0 ([#601](https://github.com/pbrissaud/suivi-bourse/issues/601)) ([f908bf7](https://github.com/pbrissaud/suivi-bourse/commit/f908bf7b59571118e8c3b74da158684eb8b73c45))
* **website:** update pnpm to v11.18.0 ([#633](https://github.com/pbrissaud/suivi-bourse/issues/633)) ([b30b16b](https://github.com/pbrissaud/suivi-bourse/commit/b30b16b1e059cb5d9cd2f253e37f84f3487e3a28))
* **website:** update react monorepo to v19.2.8 ([#612](https://github.com/pbrissaud/suivi-bourse/issues/612)) ([0fea35a](https://github.com/pbrissaud/suivi-bourse/commit/0fea35a9819ca7f6b6afc7ee9934ec7ec0414a6b))
* **workflows:** update actions/setup-node action to v7 ([#579](https://github.com/pbrissaud/suivi-bourse/issues/579)) ([466f474](https://github.com/pbrissaud/suivi-bourse/commit/466f474fd50704ddf61374fa6c26827dc3cd9d73))
* **workflows:** update astral-sh/setup-uv action to v9 ([#596](https://github.com/pbrissaud/suivi-bourse/issues/596)) ([153979a](https://github.com/pbrissaud/suivi-bourse/commit/153979a85c0825ad07af92b1c757035961f7ad0d))
* **workflows:** update dependency node to v24 ([#565](https://github.com/pbrissaud/suivi-bourse/issues/565)) ([0985797](https://github.com/pbrissaud/suivi-bourse/commit/0985797731dc20e06b0265e58894409fc5f21bea))
* **workflows:** update pnpm/action-setup action to v6 ([#566](https://github.com/pbrissaud/suivi-bourse/issues/566)) ([65a01f5](https://github.com/pbrissaud/suivi-bourse/commit/65a01f54909c3c4aff251780d9a43ff04b5a3f66))

## [4.0.1](https://github.com/pbrissaud/suivi-bourse/compare/v4.0.0...v4.0.1) (2026-07-10)


### Bug Fixes

* **ci:** build release docs with pnpm instead of yarn ([#557](https://github.com/pbrissaud/suivi-bourse/issues/557)) ([e3729f0](https://github.com/pbrissaud/suivi-bourse/commit/e3729f059c141d2494a49c94388f6a628280f8f5))

## [4.0.0](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.5...v4.0.0) (2026-07-10)


### ⚠ BREAKING CHANGES

* BREAKING — migrate storage to InfluxDB 3 with backfill; add tests, uv deps, and legacy Prometheus export ([#550](https://github.com/pbrissaud/suivi-bourse/issues/550))

### Features

* BREAKING — migrate storage to InfluxDB 3 with backfill; add tests, uv deps, and legacy Prometheus export ([#550](https://github.com/pbrissaud/suivi-bourse/issues/550)) ([ecfddd6](https://github.com/pbrissaud/suivi-bourse/commit/ecfddd635c0f1f285b6251b3d05e7e4958582a8c))
* **events:** add event-based portfolio configuration ([#495](https://github.com/pbrissaud/suivi-bourse/issues/495)) ([ebb77c4](https://github.com/pbrissaud/suivi-bourse/commit/ebb77c42a7c76313e1a37455f175e41a8bec379c))
* expose market cap, p/e ratio and dividend yield ([1b30baa](https://github.com/pbrissaud/suivi-bourse/commit/1b30baacf9ecf9814d9dcbdf370193725b354b2f))


### Dependencies

* **app:** update dependency apscheduler to v3.11.3 ([#547](https://github.com/pbrissaud/suivi-bourse/issues/547)) ([01390d7](https://github.com/pbrissaud/suivi-bourse/commit/01390d719487cc1ecc96be74d8bdf55f5b1e2e76))
* **app:** update dependency confuse to v2.2.0 ([#494](https://github.com/pbrissaud/suivi-bourse/issues/494)) ([a22cba7](https://github.com/pbrissaud/suivi-bourse/commit/a22cba7781f45929ec02913073b569d07fddcaab))
* **app:** update dependency prometheus_client to v0.24.0 ([#487](https://github.com/pbrissaud/suivi-bourse/issues/487)) ([10ae306](https://github.com/pbrissaud/suivi-bourse/commit/10ae30682fc3ed010febb1d1aad15e877d2c87c9))
* **app:** update dependency prometheus_client to v0.24.1 ([#489](https://github.com/pbrissaud/suivi-bourse/issues/489)) ([5b9bb47](https://github.com/pbrissaud/suivi-bourse/commit/5b9bb470d6cdbc7cf2747e317c6632c7182fc7f2))
* **app:** update dependency prometheus_client to v0.25.0 ([#520](https://github.com/pbrissaud/suivi-bourse/issues/520)) ([a43b29f](https://github.com/pbrissaud/suivi-bourse/commit/a43b29f8194fec4ddcf0dd0ba7f16d7448209cf4))
* **app:** update dependency urllib3 to v2.7.0 ([#535](https://github.com/pbrissaud/suivi-bourse/issues/535)) ([d896fa3](https://github.com/pbrissaud/suivi-bourse/commit/d896fa3f52b25b7f2668f5ab2fbb2238b77ac2c1))
* **app:** update dependency yfinance to v1.1.0 ([#491](https://github.com/pbrissaud/suivi-bourse/issues/491)) ([cf1c07b](https://github.com/pbrissaud/suivi-bourse/commit/cf1c07bf846c5d31e20f50432be9167a52f12e91))
* **app:** update dependency yfinance to v1.2.0 ([#498](https://github.com/pbrissaud/suivi-bourse/issues/498)) ([03d7c38](https://github.com/pbrissaud/suivi-bourse/commit/03d7c383a2055ed674e23f5c508b02965c1a4e98))
* **app:** update dependency yfinance to v1.2.1 ([#518](https://github.com/pbrissaud/suivi-bourse/issues/518)) ([243ad70](https://github.com/pbrissaud/suivi-bourse/commit/243ad70695586842a5ca198a9278898450c0b8fc))
* **app:** update dependency yfinance to v1.2.2 ([#522](https://github.com/pbrissaud/suivi-bourse/issues/522)) ([4a93c19](https://github.com/pbrissaud/suivi-bourse/commit/4a93c19eda3118c90331bd321cacaf6ca167e921))
* **app:** update dependency yfinance to v1.3.0 ([#526](https://github.com/pbrissaud/suivi-bourse/issues/526)) ([3c23f64](https://github.com/pbrissaud/suivi-bourse/commit/3c23f64a2f7a958840ed8e104dd7bfbe609593a9))
* **app:** update dependency yfinance to v1.4.0 ([#537](https://github.com/pbrissaud/suivi-bourse/issues/537)) ([edd539e](https://github.com/pbrissaud/suivi-bourse/commit/edd539ecf040e76d9a1a0db7f7cce15b813f20ec))
* **app:** update dependency yfinance to v1.4.1 ([#540](https://github.com/pbrissaud/suivi-bourse/issues/540)) ([5ae4ca4](https://github.com/pbrissaud/suivi-bourse/commit/5ae4ca49f57a3dcfad9981036591f4fc78c8221f))
* **app:** update dependency yfinance to v1.5.1 ([#548](https://github.com/pbrissaud/suivi-bourse/issues/548)) ([deffad2](https://github.com/pbrissaud/suivi-bourse/commit/deffad214b27b24bacf01418ca6372adc8e6f21b))
* **app:** update ghcr.io/astral-sh/uv docker tag to v0.11.28 ([#554](https://github.com/pbrissaud/suivi-bourse/issues/554)) ([6343f1e](https://github.com/pbrissaud/suivi-bourse/commit/6343f1e7fdcf021a7cad4cbf0545b6f0a44165f0))
* **docker-compose:** update grafana monorepo ([#545](https://github.com/pbrissaud/suivi-bourse/issues/545)) ([ff707c8](https://github.com/pbrissaud/suivi-bourse/commit/ff707c8d0bbde63f6144a48d16b8a7a023ee2a2b))
* **docker-compose:** update grafana monorepo to v12.4.4 ([#543](https://github.com/pbrissaud/suivi-bourse/issues/543)) ([4d346b0](https://github.com/pbrissaud/suivi-bourse/commit/4d346b09edb547a793e34490bb6edf4653d8dca1))
* **docker-compose:** update grafana/grafana docker tag to v12.3.2 ([#493](https://github.com/pbrissaud/suivi-bourse/issues/493)) ([da02d41](https://github.com/pbrissaud/suivi-bourse/commit/da02d411147dadddb47323b4405e0fd24519e539))
* **docker-compose:** update grafana/grafana docker tag to v12.3.3 ([#497](https://github.com/pbrissaud/suivi-bourse/issues/497)) ([b79fe49](https://github.com/pbrissaud/suivi-bourse/commit/b79fe4918eed13f7142f4a9fea1708d552d22096))
* **docker-compose:** update grafana/grafana docker tag to v12.4.0 ([#499](https://github.com/pbrissaud/suivi-bourse/issues/499)) ([7f503ca](https://github.com/pbrissaud/suivi-bourse/commit/7f503cafc4689e066b5b4ccc8ce5426a3c047106))
* **docker-compose:** update grafana/grafana docker tag to v12.4.1 ([#510](https://github.com/pbrissaud/suivi-bourse/issues/510)) ([f876c3f](https://github.com/pbrissaud/suivi-bourse/commit/f876c3f683255e95ca054e0ab59c17908b3d0706))
* **docker-compose:** update grafana/grafana docker tag to v12.4.2 ([#511](https://github.com/pbrissaud/suivi-bourse/issues/511)) ([38a799f](https://github.com/pbrissaud/suivi-bourse/commit/38a799f0ca977775b9b1ef5ac931df44d5e2d79c))
* **docker-compose:** update grafana/grafana docker tag to v12.4.3 ([#525](https://github.com/pbrissaud/suivi-bourse/issues/525)) ([7c5c8ad](https://github.com/pbrissaud/suivi-bourse/commit/7c5c8adbbe9c4b495dab29a57193b8eb35609f17))
* **docker-compose:** update grafana/grafana docker tag to v13 ([#524](https://github.com/pbrissaud/suivi-bourse/issues/524)) ([fa447b8](https://github.com/pbrissaud/suivi-bourse/commit/fa447b8476b2a1423240ed8a5066ebc7980abdf4))
* **docker-compose:** update prom/prometheus docker tag to v3.10.0 ([#500](https://github.com/pbrissaud/suivi-bourse/issues/500)) ([e67d271](https://github.com/pbrissaud/suivi-bourse/commit/e67d27115bce93145140020e7bbdd1eb74cfffdb))
* **docker-compose:** update prom/prometheus docker tag to v3.11.0 ([#515](https://github.com/pbrissaud/suivi-bourse/issues/515)) ([3424d28](https://github.com/pbrissaud/suivi-bourse/commit/3424d284aa37b28e0417088f956d018176157c87))
* **docker-compose:** update prom/prometheus docker tag to v3.11.1 ([#516](https://github.com/pbrissaud/suivi-bourse/issues/516)) ([de7335b](https://github.com/pbrissaud/suivi-bourse/commit/de7335b6a31ef5fa5e7333a29dab60df88632259))
* **docker-compose:** update prom/prometheus docker tag to v3.11.2 ([#521](https://github.com/pbrissaud/suivi-bourse/issues/521)) ([f742871](https://github.com/pbrissaud/suivi-bourse/commit/f7428719f749835d933f5d2305e367cb0d2fdc35))
* **docker-compose:** update prom/prometheus docker tag to v3.11.3 ([#532](https://github.com/pbrissaud/suivi-bourse/issues/532)) ([dcf4cdb](https://github.com/pbrissaud/suivi-bourse/commit/dcf4cdba24f8f45882e5289176ba6ede68004331))
* **docker-compose:** update prom/prometheus docker tag to v3.12.0 ([#539](https://github.com/pbrissaud/suivi-bourse/issues/539)) ([c544c53](https://github.com/pbrissaud/suivi-bourse/commit/c544c53625dbdb9f7c6878cbf941df3b74664a17))
* **docker-compose:** update prom/prometheus docker tag to v3.13.0 ([#549](https://github.com/pbrissaud/suivi-bourse/issues/549)) ([d698cba](https://github.com/pbrissaud/suivi-bourse/commit/d698cbafedb55f5eaf5b519a90fb5902ef1a7007))
* **docker-compose:** update prom/prometheus docker tag to v3.13.1 ([#551](https://github.com/pbrissaud/suivi-bourse/issues/551)) ([9f5e18a](https://github.com/pbrissaud/suivi-bourse/commit/9f5e18ad639f6ad74aa3923e25c8b09249a8a795))
* **website:** update docusaurus monorepo to v3.10.0 ([#517](https://github.com/pbrissaud/suivi-bourse/issues/517)) ([8c074b0](https://github.com/pbrissaud/suivi-bourse/commit/8c074b0dab2314b328ae3b4440d7941d9a64a0b0))
* **website:** update docusaurus monorepo to v3.10.1 ([#533](https://github.com/pbrissaud/suivi-bourse/issues/533)) ([1cc7ba6](https://github.com/pbrissaud/suivi-bourse/commit/1cc7ba65065b745730fc14a212fa13a9a93323b1))
* **website:** update node.js to v24 ([#496](https://github.com/pbrissaud/suivi-bourse/issues/496)) ([ad822b0](https://github.com/pbrissaud/suivi-bourse/commit/ad822b039f45f456b94bef611953135d4aba4bb1))
* **website:** update pnpm to v11.11.0 ([#555](https://github.com/pbrissaud/suivi-bourse/issues/555)) ([784ef14](https://github.com/pbrissaud/suivi-bourse/commit/784ef1484a0b69bf9755908368ae3f8e704f5ee0))
* **website:** update react monorepo to v19.2.4 ([#492](https://github.com/pbrissaud/suivi-bourse/issues/492)) ([9ab3282](https://github.com/pbrissaud/suivi-bourse/commit/9ab3282c6428eb9bf1d7d26a9d90ab7893f983e4))
* **website:** update react monorepo to v19.2.5 ([#519](https://github.com/pbrissaud/suivi-bourse/issues/519)) ([2da0fca](https://github.com/pbrissaud/suivi-bourse/commit/2da0fcabf5c64a544bce4a333af4658e14079a1e))
* **website:** update react monorepo to v19.2.6 ([#534](https://github.com/pbrissaud/suivi-bourse/issues/534)) ([9453e1d](https://github.com/pbrissaud/suivi-bourse/commit/9453e1dfaa40b16fbe43387a59970ff173bb4418))
* **website:** update react monorepo to v19.2.7 ([#541](https://github.com/pbrissaud/suivi-bourse/issues/541)) ([a6fe840](https://github.com/pbrissaud/suivi-bourse/commit/a6fe8406e8695aa303cbc442728d49cb497e291a))
* **workflows:** update actions/checkout action to v7 ([#544](https://github.com/pbrissaud/suivi-bourse/issues/544)) ([c409c64](https://github.com/pbrissaud/suivi-bourse/commit/c409c648e77bc54623aa476fa9cc2ecb13d8be74))
* **workflows:** update actions/configure-pages action to v6 ([#513](https://github.com/pbrissaud/suivi-bourse/issues/513)) ([882a932](https://github.com/pbrissaud/suivi-bourse/commit/882a9321c50a78615c5ba9e542bff33bd4039dc8))
* **workflows:** update actions/deploy-pages action to v5 ([#512](https://github.com/pbrissaud/suivi-bourse/issues/512)) ([6b6bf19](https://github.com/pbrissaud/suivi-bourse/commit/6b6bf19fb4f1f4656e5c5581167c7aeb7e54e239))
* **workflows:** update actions/setup-python action to v6.2.0 ([#490](https://github.com/pbrissaud/suivi-bourse/issues/490)) ([70d58ec](https://github.com/pbrissaud/suivi-bourse/commit/70d58ec9c8480b0220eef9fabfb17aff8ff3059a))
* **workflows:** update actions/setup-python action to v6.3.0 ([#546](https://github.com/pbrissaud/suivi-bourse/issues/546)) ([514ffad](https://github.com/pbrissaud/suivi-bourse/commit/514ffadc31253b0b10573336a8b362286bc390c7))
* **workflows:** update actions/upload-pages-artifact action to v5 ([#523](https://github.com/pbrissaud/suivi-bourse/issues/523)) ([c8a077a](https://github.com/pbrissaud/suivi-bourse/commit/c8a077a181bd00c4a292f4c9c1d77f78aaf6b84a))
* **workflows:** update astral-sh/setup-uv action to v8.3.2 ([#556](https://github.com/pbrissaud/suivi-bourse/issues/556)) ([180e1c1](https://github.com/pbrissaud/suivi-bourse/commit/180e1c168544dfa6d80e1be1997a4dd3ccdb3cf3))
* **workflows:** update docker/build-push-action action to v7 ([#505](https://github.com/pbrissaud/suivi-bourse/issues/505)) ([5632baa](https://github.com/pbrissaud/suivi-bourse/commit/5632baa35d9dbe0737bcd436c763a5ffa5b731bf))
* **workflows:** update docker/login-action action to v4 ([#501](https://github.com/pbrissaud/suivi-bourse/issues/501)) ([dc30d63](https://github.com/pbrissaud/suivi-bourse/commit/dc30d635e4a8734fc844d5ac48bb66fbd58e9998))
* **workflows:** update docker/metadata-action action to v6 ([#504](https://github.com/pbrissaud/suivi-bourse/issues/504)) ([f3ae6ac](https://github.com/pbrissaud/suivi-bourse/commit/f3ae6ac27ba8bd429db089e98d99e96399334841))
* **workflows:** update docker/setup-buildx-action action to v4 ([#503](https://github.com/pbrissaud/suivi-bourse/issues/503)) ([aeccaa7](https://github.com/pbrissaud/suivi-bourse/commit/aeccaa7545cac82d91fec6d1c5f0c1d3439445b9))
* **workflows:** update docker/setup-qemu-action action to v4 ([#502](https://github.com/pbrissaud/suivi-bourse/issues/502)) ([ba438cf](https://github.com/pbrissaud/suivi-bourse/commit/ba438cf0aa8f6604b0ce6c481cf7eb5c839e04f6))
* **workflows:** update googleapis/release-please-action action to v5 ([#527](https://github.com/pbrissaud/suivi-bourse/issues/527)) ([d9746b3](https://github.com/pbrissaud/suivi-bourse/commit/d9746b33bbe0dc51d4d9ada95694d12b4b70e9f4))

## [3.8.5](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.4...v3.8.5) (2026-01-12)


### Bug Fixes

* **app:** handle yfinance rate limiting with retry and backoff ([#486](https://github.com/pbrissaud/suivi-bourse/issues/486)) ([7b711d1](https://github.com/pbrissaud/suivi-bourse/commit/7b711d14e3bd8d56ddd0f3fdd029abfa98a75ce4))


### Dependencies

* **app:** update dependency apscheduler to v3.11.1 ([#469](https://github.com/pbrissaud/suivi-bourse/issues/469)) ([eb89775](https://github.com/pbrissaud/suivi-bourse/commit/eb8977592eeef36afb5e7d6dc00d94694ad9cc76))
* **app:** update dependency apscheduler to v3.11.2 ([#481](https://github.com/pbrissaud/suivi-bourse/issues/481)) ([473bf24](https://github.com/pbrissaud/suivi-bourse/commit/473bf24e15103cc9ec41c931b88142fbac0a1eff))
* **app:** update dependency cerberus to v1.3.8 ([#470](https://github.com/pbrissaud/suivi-bourse/issues/470)) ([70be10e](https://github.com/pbrissaud/suivi-bourse/commit/70be10e4295538f13ddac71087e766b434dd9440))
* **app:** update dependency confuse to v2.1.0 ([#468](https://github.com/pbrissaud/suivi-bourse/issues/468)) ([abe9b0e](https://github.com/pbrissaud/suivi-bourse/commit/abe9b0ec940a4bebdb1e24eb132ed1ba4b771dd3))
* **app:** update dependency prometheus_client to v0.22.0 ([#436](https://github.com/pbrissaud/suivi-bourse/issues/436)) ([e33c60c](https://github.com/pbrissaud/suivi-bourse/commit/e33c60c5983eff4d66217fb51617630a9f495c1c))
* **app:** update dependency prometheus_client to v0.22.1 ([#439](https://github.com/pbrissaud/suivi-bourse/issues/439)) ([815dd00](https://github.com/pbrissaud/suivi-bourse/commit/815dd0000546230cd952a1eef9411fd8887e4147))
* **app:** update dependency prometheus_client to v0.23.1 ([#459](https://github.com/pbrissaud/suivi-bourse/issues/459)) ([2f8a273](https://github.com/pbrissaud/suivi-bourse/commit/2f8a273302406b39675f9598a00bb39f39cdc003))
* **app:** update dependency pyyaml to v6.0.3 ([#462](https://github.com/pbrissaud/suivi-bourse/issues/462)) ([c7588cd](https://github.com/pbrissaud/suivi-bourse/commit/c7588cd1bb8296e77363625ba45bb94d436359bf))
* **app:** update dependency urllib3 to v2.5.0 ([#444](https://github.com/pbrissaud/suivi-bourse/issues/444)) ([0da078b](https://github.com/pbrissaud/suivi-bourse/commit/0da078be76d9c26ec6ff81ca7a2052ad254e56ba))
* **app:** update dependency urllib3 to v2.6.0 ([#476](https://github.com/pbrissaud/suivi-bourse/issues/476)) ([ce051f0](https://github.com/pbrissaud/suivi-bourse/commit/ce051f025015e754d32b9b9bb14d58a02f84a655))
* **app:** update dependency urllib3 to v2.6.1 ([#477](https://github.com/pbrissaud/suivi-bourse/issues/477)) ([26a0967](https://github.com/pbrissaud/suivi-bourse/commit/26a0967c1494fdd2a83e2ddb5315ab2219a68ee2))
* **app:** update dependency urllib3 to v2.6.2 ([#478](https://github.com/pbrissaud/suivi-bourse/issues/478)) ([9570c99](https://github.com/pbrissaud/suivi-bourse/commit/9570c997b547dfcc5e80adc81790ae5afc5383e3))
* **app:** update dependency urllib3 to v2.6.3 ([#484](https://github.com/pbrissaud/suivi-bourse/issues/484)) ([e52127a](https://github.com/pbrissaud/suivi-bourse/commit/e52127a8c1681a11e9591b93a3c100f4458687f0))
* **app:** update dependency yfinance to v0.2.56 ([#427](https://github.com/pbrissaud/suivi-bourse/issues/427)) ([89833a5](https://github.com/pbrissaud/suivi-bourse/commit/89833a58f4d1ee911a594e5ffb787708bd6f1c43))
* **app:** update dependency yfinance to v0.2.57 ([#430](https://github.com/pbrissaud/suivi-bourse/issues/430)) ([95c7072](https://github.com/pbrissaud/suivi-bourse/commit/95c707265a644b6fcec415faea4c91ac17ee974a))
* **app:** update dependency yfinance to v0.2.58 ([#431](https://github.com/pbrissaud/suivi-bourse/issues/431)) ([e0c3d6f](https://github.com/pbrissaud/suivi-bourse/commit/e0c3d6f1f244b5a212ff59219b50901556d36ab6))
* **app:** update dependency yfinance to v0.2.59 ([#433](https://github.com/pbrissaud/suivi-bourse/issues/433)) ([beca342](https://github.com/pbrissaud/suivi-bourse/commit/beca34211bf60d260968a746c8138e203e98d2ae))
* **app:** update dependency yfinance to v0.2.60 ([#434](https://github.com/pbrissaud/suivi-bourse/issues/434)) ([54a02b0](https://github.com/pbrissaud/suivi-bourse/commit/54a02b0684cfcb123b9b0eba58eb8627689e5168))
* **app:** update dependency yfinance to v0.2.61 ([#435](https://github.com/pbrissaud/suivi-bourse/issues/435)) ([7b9ba37](https://github.com/pbrissaud/suivi-bourse/commit/7b9ba376334f0505f3b9d2ff6b4ee455ca515f80))
* **app:** update dependency yfinance to v0.2.62 ([#441](https://github.com/pbrissaud/suivi-bourse/issues/441)) ([c990d77](https://github.com/pbrissaud/suivi-bourse/commit/c990d77b64b3694e866d695fc1e743e65dab1d36))
* **app:** update dependency yfinance to v0.2.63 ([#442](https://github.com/pbrissaud/suivi-bourse/issues/442)) ([1207d80](https://github.com/pbrissaud/suivi-bourse/commit/1207d80acf4487853b621350becfcc062e7e5823))
* **app:** update dependency yfinance to v0.2.64 ([#445](https://github.com/pbrissaud/suivi-bourse/issues/445)) ([7c7a0d4](https://github.com/pbrissaud/suivi-bourse/commit/7c7a0d477b7a6c9e43b6eadaf0a07efcc5d356b6))
* **app:** update dependency yfinance to v0.2.65 ([#446](https://github.com/pbrissaud/suivi-bourse/issues/446)) ([b649a72](https://github.com/pbrissaud/suivi-bourse/commit/b649a722a924b79ae38f33421bd014b0598c6fa1))
* **app:** update dependency yfinance to v0.2.66 ([#458](https://github.com/pbrissaud/suivi-bourse/issues/458)) ([138dfa2](https://github.com/pbrissaud/suivi-bourse/commit/138dfa2fa8ec49be41a8c46299e7bf1fb2f69735))
* **app:** update dependency yfinance to v1 ([#482](https://github.com/pbrissaud/suivi-bourse/issues/482)) ([fa4ed94](https://github.com/pbrissaud/suivi-bourse/commit/fa4ed94ce2e742472b57bfa78faef243432ef73c))
* **app:** update python docker tag to v3.14 ([#465](https://github.com/pbrissaud/suivi-bourse/issues/465)) ([81f0c13](https://github.com/pbrissaud/suivi-bourse/commit/81f0c13dde67d7ff79826f0dba9949ad0b04f1cb))
* **docker-compose:** update grafana/grafana docker tag to v11.6.1 ([#426](https://github.com/pbrissaud/suivi-bourse/issues/426)) ([4c0fae2](https://github.com/pbrissaud/suivi-bourse/commit/4c0fae2a46ee8c13daa488595c9a598981c99ba4))
* **docker-compose:** update grafana/grafana docker tag to v11.6.2 ([#437](https://github.com/pbrissaud/suivi-bourse/issues/437)) ([8611ab8](https://github.com/pbrissaud/suivi-bourse/commit/8611ab8759899ca0ea8766cd64e6bd227433bb74))
* **docker-compose:** update grafana/grafana docker tag to v11.6.3 ([#443](https://github.com/pbrissaud/suivi-bourse/issues/443)) ([5539225](https://github.com/pbrissaud/suivi-bourse/commit/5539225ec3db743dc2aef6e59a05fc5a7df0540a))
* **docker-compose:** update grafana/grafana docker tag to v11.6.4 ([#447](https://github.com/pbrissaud/suivi-bourse/issues/447)) ([9eee11e](https://github.com/pbrissaud/suivi-bourse/commit/9eee11e84fa867dc0433a45a80613d76cf311c56))
* **docker-compose:** update grafana/grafana docker tag to v12 ([#432](https://github.com/pbrissaud/suivi-bourse/issues/432)) ([0a96070](https://github.com/pbrissaud/suivi-bourse/commit/0a9607093c9d3a7b2371a677d5933ec3f1e7441e))
* **docker-compose:** update grafana/grafana docker tag to v12.1.1 ([#450](https://github.com/pbrissaud/suivi-bourse/issues/450)) ([ad23c9a](https://github.com/pbrissaud/suivi-bourse/commit/ad23c9a63e5156912c7ed23523c77899565cc4ba))
* **docker-compose:** update grafana/grafana docker tag to v12.2.0 ([#460](https://github.com/pbrissaud/suivi-bourse/issues/460)) ([9d5b268](https://github.com/pbrissaud/suivi-bourse/commit/9d5b26898264d96e7164a586cde0c52d277e1c57))
* **docker-compose:** update grafana/grafana docker tag to v12.2.1 ([#467](https://github.com/pbrissaud/suivi-bourse/issues/467)) ([15f9639](https://github.com/pbrissaud/suivi-bourse/commit/15f9639a4a1598015743a6921fb222c01556e96b))
* **docker-compose:** update grafana/grafana docker tag to v12.3.0 ([#471](https://github.com/pbrissaud/suivi-bourse/issues/471)) ([edd7edd](https://github.com/pbrissaud/suivi-bourse/commit/edd7edd4f7c7cec82dce3675bdb388e272fdc802))
* **docker-compose:** update grafana/grafana docker tag to v12.3.1 ([#480](https://github.com/pbrissaud/suivi-bourse/issues/480)) ([3bfa466](https://github.com/pbrissaud/suivi-bourse/commit/3bfa466ef08fcf8a9a49ee2cd194eaf98d9b6a33))
* **docker-compose:** update prom/prometheus docker tag to v3 ([#394](https://github.com/pbrissaud/suivi-bourse/issues/394)) ([3e10b5b](https://github.com/pbrissaud/suivi-bourse/commit/3e10b5bef6d9d39336b9158e86bd0190f25334a5))
* **website:** update dependency @mdx-js/react to v3.1.1 ([#454](https://github.com/pbrissaud/suivi-bourse/issues/454)) ([29a70d2](https://github.com/pbrissaud/suivi-bourse/commit/29a70d28f13722a09f57ec31b5898d9449350826))
* **website:** update docusaurus monorepo to v3.8.0 ([#438](https://github.com/pbrissaud/suivi-bourse/issues/438)) ([e6f1777](https://github.com/pbrissaud/suivi-bourse/commit/e6f177780597a32a0584064301fdec982783cb56))
* **website:** update docusaurus monorepo to v3.8.1 ([#440](https://github.com/pbrissaud/suivi-bourse/issues/440)) ([ccc3e34](https://github.com/pbrissaud/suivi-bourse/commit/ccc3e34305a08dcab6da0fb97b5d09d92e6e2ff9))
* **website:** update docusaurus monorepo to v3.9.0 ([#461](https://github.com/pbrissaud/suivi-bourse/issues/461)) ([837fa3d](https://github.com/pbrissaud/suivi-bourse/commit/837fa3d637ea44ad7e47cff4838a9370a2c62bf6))
* **website:** update docusaurus monorepo to v3.9.1 ([#463](https://github.com/pbrissaud/suivi-bourse/issues/463)) ([994577f](https://github.com/pbrissaud/suivi-bourse/commit/994577f4ff84f021f614ea4f7a30981073c5ef87))
* **website:** update docusaurus monorepo to v3.9.2 ([#466](https://github.com/pbrissaud/suivi-bourse/issues/466)) ([e8043b8](https://github.com/pbrissaud/suivi-bourse/commit/e8043b80c2e71aa5caa9760b5346dbc38ca8b6c5))
* **website:** update react monorepo to v19.1.1 ([#448](https://github.com/pbrissaud/suivi-bourse/issues/448)) ([65656cc](https://github.com/pbrissaud/suivi-bourse/commit/65656cc8fb9e604d8d33bd1cbb26c911dadfda97))
* **website:** update react monorepo to v19.2.0 ([#464](https://github.com/pbrissaud/suivi-bourse/issues/464)) ([95d1138](https://github.com/pbrissaud/suivi-bourse/commit/95d11383ff3bb65641d299b35b2f7c3607399320))
* **website:** update react monorepo to v19.2.1 ([#475](https://github.com/pbrissaud/suivi-bourse/issues/475)) ([133b259](https://github.com/pbrissaud/suivi-bourse/commit/133b259e681ddcc23aa962115fb7430caad1de76))
* **website:** update react monorepo to v19.2.3 ([#479](https://github.com/pbrissaud/suivi-bourse/issues/479)) ([98a1418](https://github.com/pbrissaud/suivi-bourse/commit/98a14187cb9ff543d9edb87a50cdc01f1f39dfdd))
* **workflows:** update actions/checkout action to v5 ([#449](https://github.com/pbrissaud/suivi-bourse/issues/449)) ([4341490](https://github.com/pbrissaud/suivi-bourse/commit/4341490b542b8b0f4145e7b6fdbecf4ffc9ea1a7))
* **workflows:** update actions/checkout action to v6 ([#472](https://github.com/pbrissaud/suivi-bourse/issues/472)) ([714f3f1](https://github.com/pbrissaud/suivi-bourse/commit/714f3f182c59301d4d736e8f6a76ad1e91cd17c8))
* **workflows:** update actions/setup-python action to v5.6.0 ([#429](https://github.com/pbrissaud/suivi-bourse/issues/429)) ([ed4a715](https://github.com/pbrissaud/suivi-bourse/commit/ed4a715202f241f1460c7f138415657c084123da))
* **workflows:** update actions/setup-python action to v6 ([#455](https://github.com/pbrissaud/suivi-bourse/issues/455)) ([393c65c](https://github.com/pbrissaud/suivi-bourse/commit/393c65ca88483edd50b48726ca8b6dbd91252d3b))
* **workflows:** update actions/setup-python action to v6.1.0 ([#474](https://github.com/pbrissaud/suivi-bourse/issues/474)) ([b4b7baa](https://github.com/pbrissaud/suivi-bourse/commit/b4b7baa2978e791c0adb57d66973739e042e0156))
* **workflows:** update actions/upload-pages-artifact action to v4 ([#452](https://github.com/pbrissaud/suivi-bourse/issues/452)) ([0de7f4d](https://github.com/pbrissaud/suivi-bourse/commit/0de7f4d026426e5d7afdeca6d5f254cd023f27ed))
* **workflows:** update tj-actions/changed-files action to v47 ([#456](https://github.com/pbrissaud/suivi-bourse/issues/456)) ([ed63003](https://github.com/pbrissaud/suivi-bourse/commit/ed630033c4609575ab519f2399a373760ee70ace))

## [3.8.4](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.3...v3.8.4) (2025-04-10)


### Dependencies

* **app:** update dependency urllib3 to v2.4.0 ([#425](https://github.com/pbrissaud/suivi-bourse/issues/425)) ([fe518cc](https://github.com/pbrissaud/suivi-bourse/commit/fe518cc350f3e4f128234634261b34143cf41c91))
* **app:** update dependency yfinance to v0.2.54 ([#415](https://github.com/pbrissaud/suivi-bourse/issues/415)) ([1af5d94](https://github.com/pbrissaud/suivi-bourse/commit/1af5d945ec5710c9b7309d00e5925703fe643fd4))
* **app:** update dependency yfinance to v0.2.55 ([#420](https://github.com/pbrissaud/suivi-bourse/issues/420)) ([ccb52a2](https://github.com/pbrissaud/suivi-bourse/commit/ccb52a2244a3accfb669f811d27ac77ca9ccfe7e))
* **docker-compose:** update grafana/grafana docker tag to v11.5.2 ([#416](https://github.com/pbrissaud/suivi-bourse/issues/416)) ([81b9f5c](https://github.com/pbrissaud/suivi-bourse/commit/81b9f5c3f036600e135a5e12b012197a6ed527da))
* **docker-compose:** update grafana/grafana docker tag to v11.5.3 ([#422](https://github.com/pbrissaud/suivi-bourse/issues/422)) ([b16fef2](https://github.com/pbrissaud/suivi-bourse/commit/b16fef20deb2a9205b1b651f371d40dc55d69e6e))
* **docker-compose:** update grafana/grafana docker tag to v11.6.0 ([#423](https://github.com/pbrissaud/suivi-bourse/issues/423)) ([d524391](https://github.com/pbrissaud/suivi-bourse/commit/d524391778dd8ae47f6b1c56a4edd4dc7e76064b))
* **website:** update react monorepo to v19.1.0 ([#424](https://github.com/pbrissaud/suivi-bourse/issues/424)) ([70cfe9f](https://github.com/pbrissaud/suivi-bourse/commit/70cfe9fb3af75337127069671dec5a8d69fca33c))
* **workflows:** update actions/setup-python action to v5.5.0 ([#421](https://github.com/pbrissaud/suivi-bourse/issues/421)) ([89e87cd](https://github.com/pbrissaud/suivi-bourse/commit/89e87cd24143317d827bf36574b2fa65864a6c4c))

## [3.8.3](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.2...v3.8.3) (2025-02-15)


### Dependencies

* **app:** update dependency apscheduler to v3.11.0 ([#399](https://github.com/pbrissaud/suivi-bourse/issues/399)) ([2613ac7](https://github.com/pbrissaud/suivi-bourse/commit/2613ac74678d467de909891d444e4a2c13b8861d))
* **app:** update dependency cerberus to v1.3.6 ([#407](https://github.com/pbrissaud/suivi-bourse/issues/407)) ([65735ba](https://github.com/pbrissaud/suivi-bourse/commit/65735ba89f12e09622cd9d79d18ba597c52cea2e))
* **app:** update dependency cerberus to v1.3.7 ([#408](https://github.com/pbrissaud/suivi-bourse/issues/408)) ([404ea9b](https://github.com/pbrissaud/suivi-bourse/commit/404ea9b1e9814fc4443217b4c3895301cbb2dcc9))
* **app:** update dependency prometheus_client to v0.21.1 ([#401](https://github.com/pbrissaud/suivi-bourse/issues/401)) ([873f08a](https://github.com/pbrissaud/suivi-bourse/commit/873f08a1c887dcff15b9f5a9b8cf6a4eac3aa011))
* **app:** update dependency urllib3 to v2.3.0 ([#406](https://github.com/pbrissaud/suivi-bourse/issues/406)) ([14a28eb](https://github.com/pbrissaud/suivi-bourse/commit/14a28eb424654315acaf2554bc92714dfe11c10b))
* **app:** update dependency yfinance to v0.2.51 ([#405](https://github.com/pbrissaud/suivi-bourse/issues/405)) ([8f210d5](https://github.com/pbrissaud/suivi-bourse/commit/8f210d5dc98c1995badae5d35377c49109278ac0))
* **app:** update dependency yfinance to v0.2.52 ([#410](https://github.com/pbrissaud/suivi-bourse/issues/410)) ([24adc9e](https://github.com/pbrissaud/suivi-bourse/commit/24adc9e976957b69fbdadac7abdb93fdd3357da0))
* **app:** update dependency yfinance to v0.2.53 ([#414](https://github.com/pbrissaud/suivi-bourse/issues/414)) ([12bd70c](https://github.com/pbrissaud/suivi-bourse/commit/12bd70c418a0f19e6831d6f0112c9973c057303b))
* **docker-compose:** update grafana/grafana docker tag to v11.4.0 ([#402](https://github.com/pbrissaud/suivi-bourse/issues/402)) ([a480f78](https://github.com/pbrissaud/suivi-bourse/commit/a480f78f09f9792b76e5c7e685f6e563bc41e136))
* **docker-compose:** update grafana/grafana docker tag to v11.5.0 ([#412](https://github.com/pbrissaud/suivi-bourse/issues/412)) ([7f2b109](https://github.com/pbrissaud/suivi-bourse/commit/7f2b109df436c427c39fe7de72878bb70362c17e))
* **docker-compose:** update grafana/grafana docker tag to v11.5.1 ([#413](https://github.com/pbrissaud/suivi-bourse/issues/413)) ([3431b39](https://github.com/pbrissaud/suivi-bourse/commit/3431b3995b4b7ca84828218ccf5926456c9a52df))
* **website:** update dependency prism-react-renderer to v2.4.1 ([#404](https://github.com/pbrissaud/suivi-bourse/issues/404)) ([0a03ac2](https://github.com/pbrissaud/suivi-bourse/commit/0a03ac2d3c57223f55081fa99b1dab8dd2e53f63))
* **website:** update docusaurus monorepo to v3.7.0 ([#409](https://github.com/pbrissaud/suivi-bourse/issues/409)) ([324d571](https://github.com/pbrissaud/suivi-bourse/commit/324d571756bc8548d424df10e32ae0b747609423))
* **website:** update react monorepo to v19 ([#403](https://github.com/pbrissaud/suivi-bourse/issues/403)) ([088753e](https://github.com/pbrissaud/suivi-bourse/commit/088753ef83ef133d83046754f3e45be7915b0319))
* **workflows:** update actions/setup-python action to v5.4.0 ([#411](https://github.com/pbrissaud/suivi-bourse/issues/411)) ([10891f3](https://github.com/pbrissaud/suivi-bourse/commit/10891f3a2ab16455c8da61cd07d72a34bd79b896))

## [3.8.2](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.1...v3.8.2) (2024-11-22)


### Dependencies

* **app:** update dependency prometheus_client to v0.21.0 ([#375](https://github.com/pbrissaud/suivi-bourse/issues/375)) ([89fb722](https://github.com/pbrissaud/suivi-bourse/commit/89fb72261c52dfd3c1cb30b1ced0a6bdd9ec72f2))
* **app:** update dependency yfinance to v0.2.44 ([#379](https://github.com/pbrissaud/suivi-bourse/issues/379)) ([57d764e](https://github.com/pbrissaud/suivi-bourse/commit/57d764e8039db2234e1544f37176eb9128f9d697))
* **app:** update dependency yfinance to v0.2.45 ([#383](https://github.com/pbrissaud/suivi-bourse/issues/383)) ([76d14c8](https://github.com/pbrissaud/suivi-bourse/commit/76d14c8220fbfbd27be17b2152a1836af139c647))
* **app:** update dependency yfinance to v0.2.46 ([#384](https://github.com/pbrissaud/suivi-bourse/issues/384)) ([4bea116](https://github.com/pbrissaud/suivi-bourse/commit/4bea116bc33a730e11c17ebe69817a1d8cefd042))
* **app:** update dependency yfinance to v0.2.47 ([#388](https://github.com/pbrissaud/suivi-bourse/issues/388)) ([15e5262](https://github.com/pbrissaud/suivi-bourse/commit/15e5262c1d0f05848a20303eb5ea2ad617553e79))
* **app:** update dependency yfinance to v0.2.48 ([#389](https://github.com/pbrissaud/suivi-bourse/issues/389)) ([9347348](https://github.com/pbrissaud/suivi-bourse/commit/93473486e52a7fccc2b6ce4afe8460f2383f022b))
* **app:** update dependency yfinance to v0.2.49 ([#393](https://github.com/pbrissaud/suivi-bourse/issues/393)) ([f5c7424](https://github.com/pbrissaud/suivi-bourse/commit/f5c742492912bc0502d51dd6ed8186b0fb5c5d68))
* **app:** update dependency yfinance to v0.2.50 ([#396](https://github.com/pbrissaud/suivi-bourse/issues/396)) ([38e3bab](https://github.com/pbrissaud/suivi-bourse/commit/38e3bab22332213aaa60239c008678c6b9ea3872))
* **app:** update python docker tag to v3.13 ([#381](https://github.com/pbrissaud/suivi-bourse/issues/381)) ([051b777](https://github.com/pbrissaud/suivi-bourse/commit/051b77758444df2805337348fdffee154ef1e671))
* **docker-compose:** update grafana/grafana docker tag to v11.2.1 ([#377](https://github.com/pbrissaud/suivi-bourse/issues/377)) ([c3a184b](https://github.com/pbrissaud/suivi-bourse/commit/c3a184bb815d4aab242362345f7161533f8688e0))
* **docker-compose:** update grafana/grafana docker tag to v11.2.2 ([#380](https://github.com/pbrissaud/suivi-bourse/issues/380)) ([1147e88](https://github.com/pbrissaud/suivi-bourse/commit/1147e888069cf436a4d8fdc6ddf834e9d1ad722d))
* **docker-compose:** update grafana/grafana docker tag to v11.3.0 ([#385](https://github.com/pbrissaud/suivi-bourse/issues/385)) ([d5b1b0a](https://github.com/pbrissaud/suivi-bourse/commit/d5b1b0a238275ee8925875a6dec9f63826050f62))
* **docker-compose:** update grafana/grafana docker tag to v11.3.1 ([#397](https://github.com/pbrissaud/suivi-bourse/issues/397)) ([a5c3518](https://github.com/pbrissaud/suivi-bourse/commit/a5c3518a4f5dac44dc6c7595bcf9856b8f17759f))
* **docker-compose:** update prom/prometheus docker tag to v2.55.0 ([#386](https://github.com/pbrissaud/suivi-bourse/issues/386)) ([73eca77](https://github.com/pbrissaud/suivi-bourse/commit/73eca771796b96b89572bb36900afcb01e333994))
* **docker-compose:** update prom/prometheus docker tag to v2.55.1 ([#391](https://github.com/pbrissaud/suivi-bourse/issues/391)) ([56fba5b](https://github.com/pbrissaud/suivi-bourse/commit/56fba5b8b40d50abe232b9d20ffd9f75aed4ff59))
* **website:** update dependency @mdx-js/react to v3.1.0 ([#382](https://github.com/pbrissaud/suivi-bourse/issues/382)) ([7ed48ed](https://github.com/pbrissaud/suivi-bourse/commit/7ed48ed65bbea51addafed89e3c674159d4922f6))
* **website:** update docusaurus monorepo to v3.6.0 ([#390](https://github.com/pbrissaud/suivi-bourse/issues/390)) ([7b3ac97](https://github.com/pbrissaud/suivi-bourse/commit/7b3ac973b5fcb1f33543c37c334d512672d43223))
* **website:** update docusaurus monorepo to v3.6.1 ([#392](https://github.com/pbrissaud/suivi-bourse/issues/392)) ([0af300d](https://github.com/pbrissaud/suivi-bourse/commit/0af300d550910bcdce24454c645992e6b7a5e8ce))
* **website:** update docusaurus monorepo to v3.6.2 ([#395](https://github.com/pbrissaud/suivi-bourse/issues/395)) ([78ab6dd](https://github.com/pbrissaud/suivi-bourse/commit/78ab6ddfd0450f1596265438acbd21903466f88e))
* **website:** update docusaurus monorepo to v3.6.3 ([#398](https://github.com/pbrissaud/suivi-bourse/issues/398)) ([1f648ea](https://github.com/pbrissaud/suivi-bourse/commit/1f648eae4ff343168e69dbb629456c6159212c3a))
* **workflows:** update actions/setup-python action to v5.3.0 ([#387](https://github.com/pbrissaud/suivi-bourse/issues/387)) ([7c4ba47](https://github.com/pbrissaud/suivi-bourse/commit/7c4ba477c569c25d77ba0e3420e9facad9f7cc32))
* **workflows:** update ytanikin/prconventionalcommits action to v1.3.0 ([#378](https://github.com/pbrissaud/suivi-bourse/issues/378)) ([158c71f](https://github.com/pbrissaud/suivi-bourse/commit/158c71ff3fa757aa1629285b0e199207d9f962a1))

## [3.8.1](https://github.com/pbrissaud/suivi-bourse/compare/v3.8.0...v3.8.1) (2024-09-12)


### Bug Fixes

* **website:** update docusaurus monorepo to v3.5.2 ([#364](https://github.com/pbrissaud/suivi-bourse/issues/364)) ([6141e7b](https://github.com/pbrissaud/suivi-bourse/commit/6141e7b04e795854d60c075af7a468f7164b68ce))


### Dependencies

* **app:** update dependency urllib3 to v2.2.3 ([#374](https://github.com/pbrissaud/suivi-bourse/issues/374)) ([f6a1dc5](https://github.com/pbrissaud/suivi-bourse/commit/f6a1dc5f673abd4a588a5a41b0f27d6a4b67dea4))
* **app:** update dependency yfinance to v0.2.42 ([#368](https://github.com/pbrissaud/suivi-bourse/issues/368)) ([3b4b660](https://github.com/pbrissaud/suivi-bourse/commit/3b4b660b13318af42d089212a18ff41d12817b2c))
* **app:** update dependency yfinance to v0.2.43 ([#369](https://github.com/pbrissaud/suivi-bourse/issues/369)) ([6287bb1](https://github.com/pbrissaud/suivi-bourse/commit/6287bb1889cd12c866fa1a84a0768ce4bc946c21))
* **docker-compose:** update grafana/grafana docker tag to v11.2.0 ([#371](https://github.com/pbrissaud/suivi-bourse/issues/371)) ([4c959f6](https://github.com/pbrissaud/suivi-bourse/commit/4c959f6e4a5aa5f75335c0f9b9458fcaa06e1778))
* **docker-compose:** update prom/prometheus docker tag to v2.54.1 ([#370](https://github.com/pbrissaud/suivi-bourse/issues/370)) ([11f0d4e](https://github.com/pbrissaud/suivi-bourse/commit/11f0d4e3245346ae09c63f0b042f57c740755b70))
* **website:** update dependency prism-react-renderer to v2.4.0 ([#373](https://github.com/pbrissaud/suivi-bourse/issues/373)) ([2e68f55](https://github.com/pbrissaud/suivi-bourse/commit/2e68f559579bcb075874e3c22626e7c5b378a5b7))
* **workflows:** update actions/setup-python action to v5.2.0 ([#372](https://github.com/pbrissaud/suivi-bourse/issues/372)) ([a6da261](https://github.com/pbrissaud/suivi-bourse/commit/a6da2617826f50c1869371db5c11a4e14661f534))
* **workflows:** update tj-actions/changed-files action to v45 ([#367](https://github.com/pbrissaud/suivi-bourse/issues/367)) ([807d38a](https://github.com/pbrissaud/suivi-bourse/commit/807d38aa2b334ce8954ca525af1c89200ae791de))

## [3.8.0](https://github.com/pbrissaud/suivi-bourse/compare/v3.7.3...v3.8.0) (2024-08-12)

No changes only version bump

## [3.7.3](https://github.com/pbrissaud/suivi-bourse/compare/v3.7.2...v3.7.3) (2024-08-12)


### Bug Fixes

* **deps:** update docusaurus monorepo to v3.5.1 ([#360](https://github.com/pbrissaud/suivi-bourse/issues/360)) ([43d51b4](https://github.com/pbrissaud/suivi-bourse/commit/43d51b400906303eec51e3faa7760d42dc5e9cf5))

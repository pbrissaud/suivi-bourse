# Changelog

## [3.8.0](https://github.com/pbrissaud/suivi-bourse/compare/v3.7.3...v3.8.0) (2024-08-12)


### Features

* add "unless stopped" for influx and grafana containers ([7d22d9f](https://github.com/pbrissaud/suivi-bourse/commit/7d22d9fabd5d96aa0be5e7314102b27c2ab42d60))
* add check function + better error handling ([7c8220e](https://github.com/pbrissaud/suivi-bourse/commit/7c8220ea4a9c0e5fd9608b31667383a11ce1dc72))
* add indication if the app runs outside Docker ([e41f7a6](https://github.com/pbrissaud/suivi-bourse/commit/e41f7a6829f5baf7429a47e5aeab714220750dc9))
* add new CLI args for influx2 ([704ec32](https://github.com/pbrissaud/suivi-bourse/commit/704ec3234d9b75f4eaa02bb11c1f8b4862202e01))
* add new variables to influxdb ([b31dcef](https://github.com/pbrissaud/suivi-bourse/commit/b31dcef636efd6357882ad78f1525b4e21b69056))
* add requirements.txt ([10bd5e4](https://github.com/pbrissaud/suivi-bourse/commit/10bd5e415896de4088c1415b302866d55869a216))
* add requirements.txt ([726e902](https://github.com/pbrissaud/suivi-bourse/commit/726e90218254686a136b7a06b139b95efdb9ae3a))
* add usage() function ([cac5cb6](https://github.com/pbrissaud/suivi-bourse/commit/cac5cb6469b169638a5293d633e936709160949e))
* app parameters configuration ([f21a5b3](https://github.com/pbrissaud/suivi-bourse/commit/f21a5b3697e74c9ba2181ded8ea226505b4e9938))
* change influx version ([c9854c7](https://github.com/pbrissaud/suivi-bourse/commit/c9854c70e5bb84307121854685015c223d82fd89))
* control startup order in docker compose ([5cb2813](https://github.com/pbrissaud/suivi-bourse/commit/5cb28132f5d3c54435c0292d914c2be21d0d95ec))
* control startup order in docker compose ([f50dcbc](https://github.com/pbrissaud/suivi-bourse/commit/f50dcbcee95c1fdf7e1ca26b5f300fc03ed9743e))
* dashboard can be updated via UI ([3d3f732](https://github.com/pbrissaud/suivi-bourse/commit/3d3f732ed9924123e3d454a155072e3504405100))
* data file validation ([fdfb534](https://github.com/pbrissaud/suivi-bourse/commit/fdfb5341c7ca3b4e5c5de4275a94bf5945692790))
* data file validation ([84ce294](https://github.com/pbrissaud/suivi-bourse/commit/84ce29430bb3092709ee5024c39b3e97a1c5600e))
* docker image uses requirements.txt ([7b58cbf](https://github.com/pbrissaud/suivi-bourse/commit/7b58cbf14a81a28d0d628e1a97b66e83cd1986ed))
* docker image uses requirements.txt ([5c6357a](https://github.com/pbrissaud/suivi-bourse/commit/5c6357a5ee8410927ae67fea534b38231b3cd5c7))
* grafana connection with influx ([15f158e](https://github.com/pbrissaud/suivi-bourse/commit/15f158e40da6314c1f5d209ba371840f1d2fd10d))
* import librairies ([8623fbe](https://github.com/pbrissaud/suivi-bourse/commit/8623fbec9e9f68c2a0f3919d306b41f3978272b7))
* update app for influx2 communication ([18edae4](https://github.com/pbrissaud/suivi-bourse/commit/18edae4e2d6f5d0d09ca910a005f91dc9af95308))
* update data example file to respect to new model ([d7192c2](https://github.com/pbrissaud/suivi-bourse/commit/d7192c2506471f4b8293bc1379396fd83e947b13))
* update data example file to respect to new model ([989a46d](https://github.com/pbrissaud/suivi-bourse/commit/989a46d6a1074e5e381a7327747154da7dbc2822))
* update data model ([e8a5587](https://github.com/pbrissaud/suivi-bourse/commit/e8a558793bab9a7eda549d69a340a6810568ef8a))
* update Grafana dashboard ([46ab77e](https://github.com/pbrissaud/suivi-bourse/commit/46ab77e773edcd0a2517af8a442d4824a750f94c))
* update grafana dashboard for flux language ([67a33cb](https://github.com/pbrissaud/suivi-bourse/commit/67a33cbcf03125bf975e1cf9c49cebb7658d4716))
* upgrade to influx 1.8.4 ([6636728](https://github.com/pbrissaud/suivi-bourse/commit/66367283dcf48505cec16b9f05c51c60bc2dde4d))
* upgrade to python 3.9 ([434c2f1](https://github.com/pbrissaud/suivi-bourse/commit/434c2f1b9a85d43e963e23d297f94e2a66f06169))
* use logging module to print errors ([79ae179](https://github.com/pbrissaud/suivi-bourse/commit/79ae179ef6c6f1e102da6ab2d19fca66e4d92c55))
* use logging module to print errors ([d950703](https://github.com/pbrissaud/suivi-bourse/commit/d9507036bf98bfca5941651013baf85b3134bc83))


### Bug Fixes

* add data/data/json to gitignore ([4118885](https://github.com/pbrissaud/suivi-bourse/commit/4118885e9c349078b415974abb8f5fcd82d44662))
* add permission to push to githuh package ([bb24e33](https://github.com/pbrissaud/suivi-bourse/commit/bb24e33fc9df545cfe14bc041a6b20b877101cb6))
* app don't sleep before exiting ([32b208d](https://github.com/pbrissaud/suivi-bourse/commit/32b208dd931c7ec43f796207f12fecdf7e186f3d))
* app don't sleep before exiting ([02e3517](https://github.com/pbrissaud/suivi-bourse/commit/02e3517be2c9c4645585b08cb205564d027ad611))
* app/requirements.txt to reduce vulnerabilities ([#221](https://github.com/pbrissaud/suivi-bourse/issues/221)) ([50c14af](https://github.com/pbrissaud/suivi-bourse/commit/50c14af0a1f8016be0d920af27428d66a106bddf))
* app/requirements.txt to reduce vulnerabilities ([#222](https://github.com/pbrissaud/suivi-bourse/issues/222)) ([d04f4ea](https://github.com/pbrissaud/suivi-bourse/commit/d04f4ea3bb15cd360910134ae8cb9edda81909e2))
* cast influxPort as a string ([ead9215](https://github.com/pbrissaud/suivi-bourse/commit/ead9215c5abca8a0b709241eba444ca2b0f914d6))
* change installation method ([2b1c34f](https://github.com/pbrissaud/suivi-bourse/commit/2b1c34f8d055e7c8eed4a5606c0ee2bacb348d53))
* change python dependencies ([0683052](https://github.com/pbrissaud/suivi-bourse/commit/0683052350aa380922fe4405fc91656ecd3478a2))
* **ci:** authorize deps and chore task types ([7fa4ebe](https://github.com/pbrissaud/suivi-bourse/commit/7fa4ebe7f34d7fdb6a712e4ca4495db663b69cfb))
* **ci:** Merge two releasing workflows ([0067e30](https://github.com/pbrissaud/suivi-bourse/commit/0067e30909af0c43a20000d7226399307efdb662))
* convert the appScrapingInterval to int ([8e620b3](https://github.com/pbrissaud/suivi-bourse/commit/8e620b35d1e999df531c79570ca0c214bcedc94c))
* correct french name ([a45342c](https://github.com/pbrissaud/suivi-bourse/commit/a45342cbecd08566a43220b657e43e92ea7b8138))
* delete patch_lib folder ([49b717d](https://github.com/pbrissaud/suivi-bourse/commit/49b717dec79225c30b6e11bdce6aedabdbfbdd51))
* delete unused CLI params ([2bd88e0](https://github.com/pbrissaud/suivi-bourse/commit/2bd88e05e9fa1cb2905fddecdbcebc17d121f78e))
* **deps:** pin dependencies ([#74](https://github.com/pbrissaud/suivi-bourse/issues/74)) ([7cd8171](https://github.com/pbrissaud/suivi-bourse/commit/7cd8171b5c2da38eafa6944a9772c1e970b2cbc4))
* **deps:** update dependency @mdx-js/react to v3.0.1 ([#314](https://github.com/pbrissaud/suivi-bourse/issues/314)) ([c16e59d](https://github.com/pbrissaud/suivi-bourse/commit/c16e59d1767b9e90758808ece387b9afea92e64a))
* **deps:** update dependency clsx to v2 ([#214](https://github.com/pbrissaud/suivi-bourse/issues/214)) ([fc36e2c](https://github.com/pbrissaud/suivi-bourse/commit/fc36e2c6e17d63468588e7057f8ceb2b62138a5c))
* **deps:** update dependency clsx to v2.1.0 ([#303](https://github.com/pbrissaud/suivi-bourse/issues/303)) ([004aeb3](https://github.com/pbrissaud/suivi-bourse/commit/004aeb34a97f5983e6a94b9ad085fcd62d0349cb))
* **deps:** update dependency clsx to v2.1.1 ([#338](https://github.com/pbrissaud/suivi-bourse/issues/338)) ([dd13512](https://github.com/pbrissaud/suivi-bourse/commit/dd13512fd6ee267f1daca4d972b3d72c4d4a1c0a))
* **deps:** update dependency prism-react-renderer to v2.3.1 ([#293](https://github.com/pbrissaud/suivi-bourse/issues/293)) ([4814907](https://github.com/pbrissaud/suivi-bourse/commit/4814907e0b95e1bdf106c451624a19f956c6e798))
* **deps:** update docusaurus monorepo to v2.1.0 ([#77](https://github.com/pbrissaud/suivi-bourse/issues/77)) ([7c5e277](https://github.com/pbrissaud/suivi-bourse/commit/7c5e27771419f7f830bc27438c8d644e4539ac94))
* **deps:** update docusaurus monorepo to v2.2.0 ([#85](https://github.com/pbrissaud/suivi-bourse/issues/85)) ([1e89bc9](https://github.com/pbrissaud/suivi-bourse/commit/1e89bc9190325c68df7280132299be4e4a015dae))
* **deps:** update docusaurus monorepo to v2.3.1 ([#140](https://github.com/pbrissaud/suivi-bourse/issues/140)) ([dfb410d](https://github.com/pbrissaud/suivi-bourse/commit/dfb410d91ee4f06821080035f78791cef0565467))
* **deps:** update docusaurus monorepo to v2.4.0 ([#163](https://github.com/pbrissaud/suivi-bourse/issues/163)) ([d467e0a](https://github.com/pbrissaud/suivi-bourse/commit/d467e0a45366a365e4bf1f326b8b472e0027479e))
* **deps:** update docusaurus monorepo to v2.4.1 ([#187](https://github.com/pbrissaud/suivi-bourse/issues/187)) ([c8b0244](https://github.com/pbrissaud/suivi-bourse/commit/c8b0244f8e1f5ed56ac4f36b48442c1ab56d2153))
* **deps:** update docusaurus monorepo to v3.1.0 ([#305](https://github.com/pbrissaud/suivi-bourse/issues/305)) ([1face1c](https://github.com/pbrissaud/suivi-bourse/commit/1face1cab1d87fc534272704acc25b426de168ca))
* **deps:** update docusaurus monorepo to v3.1.1 ([#312](https://github.com/pbrissaud/suivi-bourse/issues/312)) ([58a963b](https://github.com/pbrissaud/suivi-bourse/commit/58a963bfc2f419b07a2b3816fd7917233846dabc))
* **deps:** update docusaurus monorepo to v3.2.0 ([#331](https://github.com/pbrissaud/suivi-bourse/issues/331)) ([7434421](https://github.com/pbrissaud/suivi-bourse/commit/74344211b4799be76cd60eae8714e9767d6d408b))
* **deps:** update docusaurus monorepo to v3.2.1 ([#333](https://github.com/pbrissaud/suivi-bourse/issues/333)) ([abb1b64](https://github.com/pbrissaud/suivi-bourse/commit/abb1b64fe7f3a0b60c69c1cfdd472fb8ddf4fde8))
* **deps:** update docusaurus monorepo to v3.3.0 ([#341](https://github.com/pbrissaud/suivi-bourse/issues/341)) ([6faac1e](https://github.com/pbrissaud/suivi-bourse/commit/6faac1e9ac710eb35a932f5c819478f87832adbe))
* **deps:** update docusaurus monorepo to v3.3.2 ([#342](https://github.com/pbrissaud/suivi-bourse/issues/342)) ([ad658ce](https://github.com/pbrissaud/suivi-bourse/commit/ad658ced725c67817d7d41b41a72b7a440631fe1))
* **deps:** update docusaurus monorepo to v3.4.0 ([#347](https://github.com/pbrissaud/suivi-bourse/issues/347)) ([8407674](https://github.com/pbrissaud/suivi-bourse/commit/8407674bdf13e2738d698481609aadaa7ff35a49))
* **deps:** update docusaurus monorepo to v3.5.1 ([#360](https://github.com/pbrissaud/suivi-bourse/issues/360)) ([43d51b4](https://github.com/pbrissaud/suivi-bourse/commit/43d51b400906303eec51e3faa7760d42dc5e9cf5))
* **deps:** update react monorepo to v18 ([#120](https://github.com/pbrissaud/suivi-bourse/issues/120)) ([327a429](https://github.com/pbrissaud/suivi-bourse/commit/327a4295ecd8815c16dd6e8274860ac868874625))
* **deps:** update react monorepo to v18 ([#200](https://github.com/pbrissaud/suivi-bourse/issues/200)) ([451ad8e](https://github.com/pbrissaud/suivi-bourse/commit/451ad8e3d347b1706e7ece322f0cf8c3f27945aa))
* **deps:** update react monorepo to v18 ([#81](https://github.com/pbrissaud/suivi-bourse/issues/81)) ([8262b2e](https://github.com/pbrissaud/suivi-bourse/commit/8262b2e305524e96437373cf3c579d21837ed58e))
* **deps:** update react monorepo to v18.3.0 ([#339](https://github.com/pbrissaud/suivi-bourse/issues/339)) ([dbdb387](https://github.com/pbrissaud/suivi-bourse/commit/dbdb387bcb70d8562c2902c2700798332ff1f63e))
* **deps:** update react monorepo to v18.3.1 ([#340](https://github.com/pbrissaud/suivi-bourse/issues/340)) ([6529f39](https://github.com/pbrissaud/suivi-bourse/commit/6529f394b7d7f61f719606e5ba43ca0ea86bdc75))
* fix params shortcut ([095da69](https://github.com/pbrissaud/suivi-bourse/commit/095da69a6854d4f27f748741b8bf0c18d78769c6))
* flake8 formatting ([b0eb612](https://github.com/pbrissaud/suivi-bourse/commit/b0eb6125a1209ff51c40204272bbf76485aacf96))
* force float casting for quantity field ([9d8d16c](https://github.com/pbrissaud/suivi-bourse/commit/9d8d16c767b23a6dd5113d1b3590acf2657f8a84))
* force float casting for quantity field [#8](https://github.com/pbrissaud/suivi-bourse/issues/8) ([c68371b](https://github.com/pbrissaud/suivi-bourse/commit/c68371b0cf776036ee2c0b3c27d22efdc511f9a5))
* parsing json new model ([62eff17](https://github.com/pbrissaud/suivi-bourse/commit/62eff1795b12963081305b5f0546507848f2a130))
* releasse workflow trigger ([97039f4](https://github.com/pbrissaud/suivi-bourse/commit/97039f4ac4d92099e9b6b151e208490ea21f9953))
* remove influxdb external port ([93601dd](https://github.com/pbrissaud/suivi-bourse/commit/93601ddf0d64ff796dde39359507e5e71c945130))
* specify grafana image tag ([567cc89](https://github.com/pbrissaud/suivi-bourse/commit/567cc89f28acb228db8d82c4bcc3848f4b724632))
* specify grafana image tag ([e724d56](https://github.com/pbrissaud/suivi-bourse/commit/e724d56136b22591c6bcef389ec938aece0f8070))
* specify number type ([27f956b](https://github.com/pbrissaud/suivi-bourse/commit/27f956b58b46d7ce205440a9031618032a387cb3))
* typo in error_counter var ([4d27a8d](https://github.com/pbrissaud/suivi-bourse/commit/4d27a8d2d83f3ea4d3ad64db04cc767b8ed46ff1))

## [3.7.3](https://github.com/pbrissaud/suivi-bourse/compare/v3.7.2...v3.7.3) (2024-08-12)


### Bug Fixes

* **deps:** update docusaurus monorepo to v3.5.1 ([#360](https://github.com/pbrissaud/suivi-bourse/issues/360)) ([43d51b4](https://github.com/pbrissaud/suivi-bourse/commit/43d51b400906303eec51e3faa7760d42dc5e9cf5))

## 2.2.0

- add grafana dashboard for standalone use
- update doc for standalone use
- Create LICENSE
- Update Grafana version in stack
- Update README.md
- Delete .gitlab-ci.yml
- Create codeql-analysis.yml
- chore: add screenshot
- Create CHANGELOG

## 3.0.0

- Switch to Prometheus as TSBD
- Docker image is published to Dockerhub
- Cleaner code
- Online doc
  

## 3.0.1

- Change doc
- update hugo theme
- fix image name in build process
- change url to netlify
- change releasing system
3.0
- Update README.md
- Update Checkout action
- chore(deps): update apscheduler requirement in /app (#20)
  

## 3.0.2

- fix image name in build process
- change url to netlify
- change releasing system
3.0
- Update README.md
- Update Checkout action
- chore(deps): update apscheduler requirement in /app (#20)
- chore(deps): update yfinance requirement in /app (#18)
  

## 3.0.3

- chore(deps): update urllib3 requirement in /app (#16)
  

## 3.1.0

- Add missing python dependencies (#25)
- chore(deps): bump actions/setup-python from 2 to 3.1.0 (#26)
- chore(deps): update urllib3 requirement in /app (#24)
- Update checkout action in CI (#29)
- Update doc template version (#30)
- Update Grafana and Prometheus version (#31)
  

## 3.1.1

- Update pull-request-fake.yml
- chore(deps): bump actions/setup-python from 3.1.0 to 3.1.1 (#37)
- Fix image tag in docker-compose
- Update docker-compose.yaml
- chore(deps): bump actions/setup-python from 3.1.0 to 3.1.2 (#38)
- chore(deps): bump github/codeql-action from 1 to 2 (#40)
  

## 3.1.2

- chore(deps): bump docker/build-push-action from 2 to 3 (#45)
- chore(deps): bump docker/setup-qemu-action from 1 to 2 (#44)
- chore(deps): bump docker/login-action from 1 to 2 (#43)
- chore(deps): bump docker/metadata-action from 3 to 4 (#42)
- chore(deps): bump docker/setup-buildx-action from 1 to 2 (#41)
- chore(deps): update prometheus-client requirement in /app (#36)
  

## 3.1.3

- chore(deps): bump actions/setup-python from 3.1.2 to 4.0.0 (#46)
  

## 3.2.0

- Add some docs (Fix #33, #39)
- Use Grafana Candlestick panel (Fix #35)
- Add a new metric sb_share_info to store some useful information (Fix #55)
- Refactoring
- Dependencies update

## 3.2.1

- Update README.md
- Change doc framework  (#63)
  

## 3.2.2

- fix broken link in docs
- update docs url
- chore(deps): bump urllib3 from 1.26.11 to 1.26.12 in /app (#64)
- Update README.md
- chore(deps): bump yfinance from 0.1.74 to 0.1.77 in /app (#65)
  

## 3.2.3

- chore(deps): bump prometheus-client from 0.14.1 to 0.15.0 in /app (#66)
- chore(deps): bump actions/setup-python from 4.1.0 to 4.3.0 (#67)
- chore(deps): bump yfinance from 0.1.77 to 0.1.81 in /app (#68)
  

## 3.2.4

- Update dependabot.yml
- chore(deps): add renovate.json (#73)
- fix(deps): pin dependencies (#74)
- chore(deps): update grafana/grafana docker tag to v9.2.1 (#75)
- fix(deps): update docusaurus monorepo to v2.1.0 (#77)
- fix(deps): update react monorepo to v18 (#81)
- chore(deps): update actions/checkout action to v3 (#79)
- Revert "fix(deps): update react monorepo to v18 (#81)"
- chore(deps): update prom/prometheus docker tag to v2.39.1 (#78)
- chore(deps): update python docker tag to v3.11 (#82)
  

## 3.2.5

- chore(deps): update grafana/grafana docker tag to v9.2.2 (#83)
- fix(deps): update docusaurus monorepo to v2.2.0 (#85)
- Better testing procedure (#88)
- fix releasing workflow
- chore(deps): update dependency yfinance to v0.1.85 (#84)
- chore(deps): update grafana/grafana docker tag to v9.2.3 (#87)
- Release 3.2.4 (#91)
  

## 3.2.6

- change releasing process
- chore: remove check on workflows
- chore: remove comments
  

## 3.3.0

- Change the way to get the last_quote (#93)
  

## 3.3.1

- chore(deps): update grafana/grafana docker tag to v9.2.4 (#96)
- chore(deps): update prom/prometheus docker tag to v2.40.0 (#95)
- chore(deps): bump loader-utils from 2.0.2 to 2.0.3 in /website (#97)
- chore(deps): update prom/prometheus docker tag to v2.40.1 (#98)
- chore(deps): bump apscheduler from 3.9.1 to 3.9.1.post1 in /app (#100)
- chore(deps): update dependency yfinance to v0.1.86 (#101)
- chore(deps): bump loader-utils from 2.0.3 to 2.0.4 in /website (#102)
- chore(deps): update dependency yfinance to v0.1.87 (#103)
- chore(deps): update grafana/grafana docker tag to v9.2.5 (#104)
- chore(deps): update prom/prometheus docker tag to v2.40.2 (#105)
  

## 3.3.2

- chore(deps): update dependency urllib3 to v1.26.13 (#107)
- chore(deps): update prom/prometheus docker tag to v2.40.3 (#108)
- chore(deps): update grafana/grafana docker tag to v9.2.6 (#106)
- chore(deps): update actions/setup-python action to v4.3.1 (#112)
- chore(deps): update grafana/grafana docker tag to v9.3.1 (#111)
- chore(deps): update prom/prometheus docker tag to v2.40.5 (#110)
- chore(deps): update dependency yfinance to v0.1.89 (#114)
- chore(deps): update prom/prometheus docker tag to v2.40.6 (#113)
- chore(deps): update dependency yfinance to v0.1.90 (#115)
- upgrade yfinance
- upgrade prometheus and grafana
- upgrade doc libs
- upgrade docker to python 3.11
- chore(deps): bump actions/setup-python from 4.3.1 to 4.4.0 (#128)
- fix(deps): update react monorepo to v18 (#120)
- chore(deps): update tj-actions/changed-files action to v35 (#122)
  

## 3.3.3

- chore(deps): update dependency yfinance to v0.2.6 (#131)
- chore(deps): update grafana/grafana docker tag to v9.3.4 (#136)
- chore(deps): bump actions/setup-python from 4.4.0 to 4.5.0 (#134)
- update docs libs
- update app deps
- fix yfinance
- chore(deps): update grafana/grafana docker tag to v9.3.6 (#139)
  

## 3.3.4

- Pass to docusaurus 2.30 ; come back to React 17
- chore(deps): update dependency yfinance to v0.2.9 (#138)
- chore(deps): update docker/build-push-action action to v4 (#145)
  

## 3.4.0

- chore(deps): update dependency apscheduler to v3.10.0 (#146)
- chore(deps): update prom/prometheus docker tag to v2.42.0 (#147)
- fix(deps): update docusaurus monorepo to v2.3.1 (#140)
- chore(deps): bump http-cache-semantics from 4.1.0 to 4.1.1 in /website (#148)
- chore(deps): bump yfinance from 0.2.9 to 0.2.11 in /app (#150)
- chore(deps): update dependency yfinance to v0.2.12 (#151)
- Fix PATH in bumping script
- 💥Migrate to Ticker.fast_info
  
## 3.4.1

- switch to github pages
  

## 3.4.2

- fix docusaurus config
  

## 3.4.3

- fix edit url
- fix linting
- chore(deps): update grafana/grafana docker tag to v9.4.1 (#152)
- chore(deps): update dependency apscheduler to v3.10.1 (#154)
- chore(deps): update grafana/grafana docker tag to v9.4.3 (#153)
- chore(deps): update dependency urllib3 to v1.26.15 (#156)
- chore(deps): bump webpack from 5.75.0 to 5.76.1 in /website (#157)
- chore(deps): update actions/deploy-pages action to v2 (#158)
- fix(deps): update docusaurus monorepo to v2.4.0 (#163)
- chore(deps): update grafana/grafana docker tag to v9.4.7 (#162)
- chore(deps): update dependency yfinance to v0.2.14 (#161)
- chore(deps): update prom/prometheus docker tag to v2.43.0 (#160)
  

## 3.4.4

- Push docker image to ghcr aswell
  

## 3.4.5

- fix: add permission to push to githuh package
- fix: releasse workflow trigger
  

## 3.5.0

- Revert to Ticker.info (#173)
- chore(deps): bump confuse from 2.0.0 to 2.0.1 in /app (#169)
  

## 3.5.1

- Create CODE_OF_CONDUCT.md
- Create SECURITY.md
- Update SECURITY.md
- chore(deps): bump actions/setup-python from 4.5.0 to 4.6.0 (#175)
- chore(deps): update grafana/grafana docker tag to v9.5.1 (#177)
- fix(deps): update docusaurus monorepo to v2.4.1 (#187)
- chore(deps): update prom/prometheus docker tag to v2.44.0 (#181)
- chore(deps): update dependency yfinance to v0.2.20 (#196)
- chore(deps): update grafana/grafana docker tag to v9.5.3 (#195)
- chore(deps): bump prometheus-client from 0.16.0 to 0.17.0 in /app (#192)
- chore(deps): update actions/setup-python action to v4.6.1 (#189)
- chore(deps): bump tj-actions/changed-files from 35 to 36 (#194)
- chore(deps): update dependency urllib3 to v2 (#178)
- Update deps for documentation website
- chore(deps): bump tj-actions/changed-files from 36 to 37 (#206)
- chore(deps): bump yfinance from 0.2.20 to 0.2.22 in /app (#205)
- chore(deps): update prom/prometheus docker tag to v2.45.0 (#203)
- fix(deps): update react monorepo to v18 (#200)
- chore(deps): update grafana/grafana docker tag to v9.5.5 (#202)
  

## 3.5.2

- update python deps
- update github actions deps
- fix(deps): update dependency clsx to v2 (#214)
- chore(deps): bump semver from 5.7.1 to 5.7.2 in /website (#211)
- update grafana to v10
  

## 3.5.3

- use yfinance logger
- chore(deps): update dependency pyyaml to v6.0.1 (#220)
- chore(deps): update dependency yfinance to v0.2.25 (#213)
- fix: app/requirements.txt to reduce vulnerabilities (#221)
- fix: app/requirements.txt to reduce vulnerabilities (#222)
- chore(deps): update dependency urllib3 to v2.0.4 (#223)
- chore(deps): update dependency yfinance to v0.2.26 (#224)
  

## 3.6.0

- chore(deps): update grafana/grafana docker tag to v10.0.3 (#228)
- update actions
- update libs
- chore(deps): bump yfinance from 0.2.29 to 0.2.30 in /app (#254)
- Update docusaurus to v3
- Update GitHub Actions versions
- chore(deps): update dependency yfinance to v0.2.32 (#264)
- chore(deps): update python docker tag to v3.12 (#263)
- chore(deps): bump actions/deploy-pages from 2 to 4 (#298)
- chore(deps): bump tj-actions/changed-files from 40 to 41 (#297)
- Enable automerge
- chore(deps): update actions/setup-python action to v5 (#288)
- chore(deps): update dependency urllib3 to v2.0.7 [security] (#261)
- chore(deps): update dependency yfinance to v0.2.33 (#289)
- chore(deps): update actions/upload-pages-artifact action to v3 (#295)
- chore(deps): update prom/prometheus docker tag to v2.48.1 (#227)
- chore(deps): update grafana/grafana docker tag to v10.2.3 (#238)
- chore(deps): update dependency urllib3 to v2.1.0 (#301)
- chore(deps): update dependency prometheus_client to v0.19.0 (#285)
- ci: use cache pip in Github Actions (#302)
- chore(deps): upgrade yarn dependencies
- fix(deps): update dependency prism-react-renderer to v2.3.1 (#293)
  

## 3.6.1

- fix(deps): update dependency clsx to v2.1.0 (#303)
- fix(deps): update docusaurus monorepo to v3.1.0 (#305)
- chore(deps): update dependency yfinance to v0.2.35 (#306)
  

## 3.6.2

- chore(deps): update prom/prometheus docker tag to v2.49.0 (#307)
- chore(deps): update prom/prometheus docker tag to v2.49.1 (#308)
- chore(deps): update tj-actions/changed-files action to v42 (#309)
- chore(deps): update dependency yfinance to v0.2.36 (#310)
- chore(deps): update grafana/grafana docker tag to v10.3.1 (#311)
- fix(deps): update docusaurus monorepo to v3.1.1 (#312)
- chore(deps): update dependency urllib3 to v2.2.0 (#313)
  

## 3.6.3

- fix(deps): update dependency @mdx-js/react to v3.0.1 (#314)
- chore(deps): update grafana/grafana docker tag to v10.3.3 (#315)
- chore(deps): update dependency prometheus_client to v0.20.0 (#316)
- chore(deps): update dependency urllib3 to v2.2.1 (#317)
  

## 3.6.4

- Mark website folder as documentation
- chore(deps): update prom/prometheus docker tag to v2.50.0 (#318)
- chore(deps): update dependency yfinance to v0.2.37 (#319)
  

## 3.7.0

- chore(deps): update prom/prometheus docker tag to v2.50.1 (#320)
- chore(deps): update grafana/grafana docker tag to v10.4.0 (#321)
- chore(deps): update tj-actions/changed-files action to v43 (#322)
- chore(deps): update prom/prometheus docker tag to v2.51.0 (#324)
- chore(deps): update grafana/grafana docker tag to v10.4.1 (#325)
- chore(deps): update actions/setup-python action to v5.1.0 (#327)
- chore(deps): update prom/prometheus docker tag to v2.51.1 (#330)
- fix(deps): update docusaurus monorepo to v3.2.0 (#331)
- chore(deps): update actions/configure-pages action to v5 (#332)
- chore(deps): update tj-actions/changed-files action to v44 (#329)
- fix(deps): update docusaurus monorepo to v3.2.1 (#333)
- chore(deps): update prom/prometheus docker tag to v2.51.2 (#334)
- chore(deps): update grafana/grafana docker tag to v10.4.2 (#336)
- chore(deps): update dependency yfinance to v0.2.38 (#337)
- fix(deps): update dependency clsx to v2.1.1 (#338)
- fix(deps): update react monorepo to v18.3.0 (#339)
- fix(deps): update react monorepo to v18.3.1 (#340)
- fix(deps): update docusaurus monorepo to v3.3.0 (#341)
- fix(deps): update docusaurus monorepo to v3.3.2 (#342)
- Small refacto on data flow and error handling (#335)
  

## 3.7.1

- chore(deps): update prom/prometheus docker tag to v2.52.0 (#343)
- chore(deps): update grafana/grafana docker tag to v10.4.3 (#344)
- chore(deps): update dependency yfinance to v0.2.40 (#346)
- fix(deps): update docusaurus monorepo to v3.4.0 (#347)
- chore(deps): update to grafana v11 (#345)
  

## 3.7.2

- chore(deps): update dependency urllib3 to v2.2.2 (#349)
- chore(deps): update prom/prometheus docker tag to v2.53.0 (#350)
- chore(deps): update docker/build-push-action action to v6 (#348)
- chore(deps): bump ws from 7.5.9 to 7.5.10 in /website (#351)

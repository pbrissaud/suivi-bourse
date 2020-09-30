# Suivi Bourse

Dépôts de fichiers contenant le code du script python récupérant à intervalle de temps régulier les valeurs des actions spécifiées en paramètres et les enregistrant dans une base influxdb

## Deploiement

```
cd suivi-bourse
pipenv install
pipenv shell
cp patchs_libs/base.py ~/.local/share/virtualenvs/suivi-bourse-*/lib/python3.8/site-packages/yfinance/base.py
pipenv run python3 script.py
```

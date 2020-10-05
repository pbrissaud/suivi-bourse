# Suivi Bourse

Application pour suivre les cours des actions que vous possédez.

Script python qui récupère les données de l'API yfinance et qui les stocke dans une base InfluxDB. Grafana pour la visualisation des données

## Installation

1. Créer un fichier data.json dans le dossier **data**. Vous pouvez suivre l'exemple donné dans le fichier **data-example.json**

2. Lancer la stack : `docker-compose up`

3. Allez sur http://localhost:3000 (ou l'adresse IP de la machine docker) et connectez-vous :

- login : admin
- mot de passe : admin

4. Changer le mot de passe **admin**

5. Allez sur le dashboard **"Suivi Bourse"**

## Reports de bugs / Demandes d'amélioration

N'hésitez pas à créer une issue sur Github !

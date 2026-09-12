---
title: Accueil
id: home
description: Ce qu’est SuiviBourse, et ce qu’il n’est pas
slug: /
---

# SuiviBourse

Un suivi de portefeuille boursier personnel. Vous enregistrez ce que vous avez
acheté, vendu, reçu et versé ; il récupère les cours, valorise vos positions et
calcule vos rendements — dans un seul conteneur, sans rien d’autre à installer.

## Ce qu’il fait

- **Il tient votre grand livre.** Six sortes d’événement — `BUY`, `SELL`,
  `GRANT`, `DIVIDEND`, `DEPOSIT`, `WITHDRAWAL` — saisis dans l’application ou
  importés depuis les fichiers qu’exporte votre courtier. Vos événements sont la
  seule chose qu’il traite comme vôtre ; tout le reste de ce qu’il affiche en est
  dérivé et peut être recalculé.
- **Il récupère les cours, et il récupère le passé.** Un titre dont le marché est
  ouvert est relevé souvent, un titre dont le marché est fermé dort jusqu’à sa
  réouverture, et l’historique antérieur à votre premier achat est reconstruit en
  arrière-plan jusqu’à l’atteindre.
- **Il rend compte dans une seule devise.** Tout ce que vous détenez est converti
  dans une devise de base unique, si bien qu’un portefeuille réparti sur
  plusieurs marchés s’additionne quand même en un seul chiffre.
- **Il vous montre cinq pages** — un tableau de bord, vos titres, vos comptes, le
  grand livre que vous lui avez confié et ce qu’est cette installation — et
  chaque chiffre explique, sur le chiffre lui-même, la convention sur laquelle il
  repose.
- **Il a une interface, et c’est celle-là.** Tout ce que l’application sait
  d’elle-même, elle le dit sur ces pages ; il n’y a pas de seconde surface à
  moissonner ni de second port à publier.

## Ce qu’il n’est pas

- **Ni un courtier, ni un conseiller.** Il n’exécute rien, ne recommande rien et
  ne sait rien que vos événements ne lui aient dit.
- **Pas une pile logicielle.** Aucune base de données à faire tourner à côté,
  aucun outil de tableaux de bord à provisionner et rien à composer : une image,
  un magasin, un processus.
- **Pas un terminal de marché.** Les cours viennent de Yahoo! Finance à une
  cadence courtoise ; plus un point est ancien, plus il est conservé
  grossièrement.
- **Pas une mise à niveau de la version 4.** Une installation en version 5 est
  une installation neuve dont le dossier d’import se trouve être plein — voir
  [Venir de la v4](./coming-from-v4.mdx).

## Commencez ici

[Premiers pas](./get-started.mdx), c’est une commande et un écran.

## Support, licence, remerciements

Pour signaler un problème ou demander une fonctionnalité,
[ouvrez un ticket](https://github.com/pbrissaud/suivi-bourse/issues/new/choose).
Les pull requests sont bienvenues — merci de lire d’abord
[le guide de contribution](https://github.com/pbrissaud/suivi-bourse/blob/master/CONTRIBUTING.md). Le projet est sous [licence MIT](https://github.com/pbrissaud/suivi-bourse/blob/master/LICENSE),
et doit beaucoup aux mainteneurs des projets sur lesquels il s’appuie.

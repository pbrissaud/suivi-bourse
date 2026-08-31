export const meta = {
  name: 'v5-wave',
  description: 'Implémente une vague de tickets v5 : un worktree par ticket, vérification adversariale, merges sérialisés sur preview/v5',
  whenToUse: "Quand une vague du graphe v5 (#669) est débloquée. args = { wave: [numéros], base: 'preview/v5' }",
  phases: [
    { title: 'Implémenter', detail: 'un agent par ticket, chacun dans son worktree' },
    { title: 'Vérifier', detail: 'relecture adversariale du diff contre les critères d’acceptation' },
    { title: 'Corriger', detail: 'les défauts mineurs dans le périmètre du ticket, avant le merge' },
    { title: 'Intégrer', detail: 'merges --no-ff sérialisés sur la base' },
  ],
}

// `args` arrive tantôt comme objet, tantôt comme la chaîne JSON de cet objet
// selon l'appelant — les deux formes sont acceptées.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { input = {} }
}

const BASE = (input && input.base) || 'preview/v5'
const WAVE = (input && input.wave) || []

// Un défaut `major` marqué `other_ticket` ne bloquait rien : c'est ainsi que le
// critère ICU de #713 a été fusionné non tenu, routé vers #718 et vivant nulle
// part. Il retient désormais la fusion **jusqu'à ce qu'il soit écrit sur le
// ticket propriétaire** — écriture faite par un humain, jamais par un agent :
// six agents en parallèle sur un tracker public, un numéro de ticket confondu,
// et le commentaire ne se retire pas discrètement.
// Une fois l'écriture faite, relancer en listant ici les tickets acquittés.
const ACK = new Set((input && input.acknowledgedRouting) || [])

// Un critère honnêtement déclaré `partial` n'est ni un `defect` ni un
// `overstated` : il ne passait par aucun des deux seuils. C'est l'honnêteté de
// l'agent qui a tenu sur le critère 9 de #696, pas le script. Un critère non
// tenu retient donc la fusion — **sauf** un `impossible` qui dit ce qu'il faut
// d'un humain, parce que c'est le mécanisme de signalement fonctionnant comme
// prévu, pas une dérive silencieuse.
const ACK_UNMET = new Set((input && input.acknowledgedUnmet) || [])

// **La fusion n'est pas le travail d'un agent.** Six tentatives de merge par
// sous-agent ont été arrêtées : écrire dans une branche d'intégration partagée
// et publique est un geste qui mérite un humain, et le harnais a raison de le
// dire. Le workflow s'arrête donc sur « vérifié, prêt à fusionner » et rend les
// commandes. `merge: true` restaure l'ancien comportement pour un dépôt où ça
// ne pose pas de question.
const MERGE = !!(input && input.merge)

const unmetCriteria = (impl) => (impl.criteria || []).filter(
  c => c.status === 'partial' ||
       c.status === 'not_met' ||
       (c.status === 'impossible' && !(c.needs_human || '').trim())
)

if (!WAVE.length) {
  log(`Aucun ticket dans la vague — args reçu : ${JSON.stringify(args)}`)
  return { merged: [], held: [], error: 'wave vide' }
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'branch', 'worktree_path', 'base_ok', 'committed', 'criteria', 'gates', 'flagged', 'summary'],
  properties: {
    issue: { type: 'integer' },
    branch: { type: 'string' },
    worktree_path: {
      type: 'string',
      description: 'le chemin absolu de ton répertoire de travail (`pwd` à la racine du dépôt) — une étape ultérieure y reviendra',
    },
    base_ok: {
      type: 'boolean',
      description: 'true seulement si `git merge-base --is-ancestor <base> HEAD` a réussi — la branche descend bien de la base',
    },
    committed: { type: 'boolean', description: 'true si au moins un commit existe sur la branche' },
    criteria: {
      type: 'array',
      description: 'un élément par case à cocher de la section Acceptance criteria, dans l’ordre du ticket',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'status', 'evidence'],
        properties: {
          text: { type: 'string', description: 'le critère, abrégé à 100 caractères' },
          status: { enum: ['met', 'partial', 'not_met', 'impossible'] },
          evidence: { type: 'string', description: 'fichier:ligne ou commande exécutée qui le prouve' },
          needs_human: {
            type: 'string',
            description:
              'ce qu’il faut d’un humain, précisément. **Obligatoire quand status vaut `impossible`** — ' +
              'un `impossible` muet est traité comme un critère non tenu et retient la fusion.',
          },
        },
      },
    },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cmd', 'passed', 'output_tail'],
        properties: {
          cmd: { type: 'string' },
          passed: { type: 'boolean' },
          output_tail: { type: 'string', description: 'les dernières lignes utiles, vide si succès' },
        },
      },
    },
    flagged: {
      type: 'array',
      description: 'ce qui exige un humain : décision non tranchée par le ticket, asset binaire, choix de rédaction assumé',
      items: { type: 'string' },
    },
    summary: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'safe_to_merge', 'overstated', 'defects'],
  properties: {
    issue: { type: 'integer' },
    safe_to_merge: { type: 'boolean' },
    overstated: {
      type: 'array',
      description: 'critères que l’implémenteur a déclarés "met" alors que le diff ne les tient pas',
      items: { type: 'string' },
    },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'scope', 'what', 'where'],
        properties: {
          severity: {
            enum: ['blocking', 'major', 'minor'],
            description:
              'blocking = portail rouge, régression, critère central non tenu. ' +
              'major = un critère d’acceptation n’est pas tenu, quelle que soit sa taille apparente. ' +
              'minor = résidu, propreté, dette — aucun critère en jeu.',
          },
          scope: {
            enum: ['this_ticket', 'other_ticket'],
            description:
              'this_ticket = le défaut tombe dans les critères de CE ticket ou dans les fichiers qu’il touche. ' +
              'other_ticket = il appartient au périmètre d’un autre ticket de la carte.',
          },
          owner_issue: {
            type: 'integer',
            description: 'si scope=other_ticket, le numéro du ticket à qui le défaut appartient (0 si inconnu)',
          },
          what: { type: 'string' },
          where: { type: 'string' },
        },
      },
    },
  },
}

const implPrompt = (n) => `
Tu implémentes le ticket GitHub #${n} du dépôt pbrissaud/suivi-bourse. Tu es dans un worktree git
isolé de ce dépôt — les autres tickets de la vague sont implémentés en parallèle ailleurs, tu ne
vois qu'eux, tu ne les attends pas.

## 1. La branche — **le tout premier geste, avant même de lire le ticket**

**Ne suppose pas que ton worktree est déjà sur la bonne base.** Il ne l'est pas
nécessairement : le harnais peut t'avoir posé sur une tête de \`master\`, où \`docs/adr/\`
n'existe pas et où le travail des vagues précédentes est absent. Un ticket v5 implémenté
depuis \`master\` est un ticket implémenté à l'aveugle.

Donc, **point de départ explicite** :

\`\`\`
git switch -c feat/${n}-<slug-court-en-anglais> ${BASE}
\`\`\`

Puis **vérifie**, et n'avance qu'en cas de succès :

\`\`\`
git merge-base --is-ancestor ${BASE} HEAD && echo BASE_OK
git log --oneline -1 ${BASE}
ls docs/adr/ | head
\`\`\`

Si \`${BASE}\` n'existe pas localement, essaie \`git fetch origin ${BASE}\` puis
\`origin/${BASE}\` comme point de départ. Si tu ne parviens toujours pas à partir de
\`${BASE}\`, **arrête-toi là** : rends \`base_ok: false\`, \`committed: false\` et dis pourquoi
dans \`summary\`. Ne fais rien d'autre — mieux vaut ne rien produire que produire depuis la
mauvaise base.

Ne rebase pas, ne pousse rien (\`git push\` est interdit — l'intégration est faite par une
autre étape).

## 2. Lire, avant d'écrire une ligne

- \`gh issue view ${n} --comments\` — le corps ET les commentaires.
- Le ticket ouvre par une ligne \`## Parent\` nommant sa **spec** (#695 magasin / #712 front /
  #730 paquetage), la **carte** #669, et des **ADR**. Lis la spec parente (\`gh issue view <n>\`)
  et chaque ADR cité (\`docs/adr/\` à la racine du dépôt).
- Lis \`CLAUDE.md\`. **Règle d'arbitrage : \`CLAUDE.md\` décrit la v4 en place, les ADR décrivent
  la destination. Quand les deux se contredisent, l'ADR gagne.**
- Ces tickets sont denses parce que chaque critère encode une enquête déjà menée. Le corps du
  ticket dit *pourquoi* chaque critère est ce qu'il est. **Un critère appliqué sans son pourquoi
  est un critère raté.** Ne réabrège pas, ne réoptimise pas, ne « simplifie » pas une décision
  que le ticket a explicitement prise.

## 3. Implémenter

Écris le code comme le code alentour : même densité de commentaires, mêmes idiomes, même
nommage. Le dépôt est francophone dans ses tickets et ses ADR ; le code, les identifiants et
les fichiers sources de documentation restent en anglais sauf quand le ticket dit le contraire.

Tu traites **tous** les critères d'acceptation. Si l'un est hors de ta portée (un asset binaire,
une capture d'écran, une décision que le ticket laisse ouverte), tu ne le contournes pas en
silence : tu fais le maximum vérifiable, tu marques le critère \`impossible\` et tu l'inscris
dans \`flagged\` avec ce qu'il faut d'un humain.

## 4. Les portails — obligatoires avant de committer

Fais tourner ce qui concerne les fichiers que tu as touchés, et **corrige jusqu'au vert** :

- \`website/\` → \`cd website && pnpm install --frozen-lockfile && pnpm build\`
  (\`onBrokenLinks: 'throw'\` : un lien mort casse la construction — c'est voulu)
- \`src/application/\`, \`src/api/\` ou \`tests/\` → \`uv sync && uv run flake8 src/application src/api --ignore=E501 && uv run pytest tests/\`
- \`src/web/\` → \`cd src/web && pnpm install && pnpm lint\` puis \`pnpm build\`, et \`pnpm test\` s'il existe
- \`Dockerfile\` → \`docker build -t suivi-bourse:pr .\` puis \`IMAGE=suivi-bourse:pr .github/scripts/container-contract.sh\` (le job \`Container\` de la CI, #744)

Un portail rouge que tu ne sais pas réparer se déclare \`passed: false\` avec sa sortie. **Tu ne
maquilles jamais un portail** (pas de test désactivé, pas de \`--no-verify\`, pas de lien
transformé en texte pour faire passer la construction).

## 5. Committer

Commits conventionnels, **signés DCO** :

\`\`\`
git commit -s -m "<type>(<scope>): <sujet>" -m "Refs #${n}"
\`\`\`

Types autorisés : \`feat\`, \`fix\`, \`docs\`, \`deps\`, \`chore\`, \`refactor\`. Découpe en commits
lisibles plutôt qu'un seul commit fourre-tout.

## 6. Rendre

Ta sortie finale est l'objet structuré, pas un message à un humain. Un élément de \`criteria\` par
case à cocher du ticket, **dans l'ordre**, avec une preuve vérifiable (\`fichier:ligne\` ou la
commande exécutée). Sois exact plutôt que flatteur : un \`partial\` honnête vaut infiniment mieux
qu'un \`met\` optimiste — l'étape suivante relit ton diff pour te contredire.

Ce que les statuts déclenchent, pour que tu saches ce que tu dis :

- **\`partial\` / \`not_met\` retiennent la fusion.** Ce n'est pas une punition de l'honnêteté :
  c'est ce qui garantit qu'un critère non tenu est *vu*, décidé par un humain, et reporté sur le
  ticket qui le portera. Déclare-les quand même — les maquiller en \`met\` est la seule faute.
- **\`impossible\` passe, à une condition : renseigner \`needs_human\`**, précisément (l'exemple
  type est un binaire qu'aucun agent ne peut produire — une capture d'écran). Un \`impossible\`
  qui ne dit pas ce qu'il faut d'un humain est traité comme un critère non tenu.
- Ne **jamais** rétrograder un critère en \`impossible\` pour éviter la retenue.
`

const verifyPrompt = (n, impl) => `
Tu relis, en adversaire, l'implémentation du ticket #${n} du dépôt pbrissaud/suivi-bourse.
Ton hypothèse par défaut est que l'implémenteur a surestimé ce qu'il a fait. Ton travail est de
le prouver, pas de le confirmer.

Le diff est sur la branche \`${impl.branch}\` :

\`\`\`
git diff ${BASE}...${impl.branch}
git log --oneline ${BASE}..${impl.branch}
\`\`\`

L'implémenteur déclare :

${JSON.stringify(impl.criteria, null, 2)}

Portails déclarés : ${JSON.stringify(impl.gates)}
Signalé comme exigeant un humain : ${JSON.stringify(impl.flagged)}

## Ce que tu vérifies

1. \`gh issue view ${n}\` — lis les critères d'acceptation **à la source**, pas la reformulation
   ci-dessus. Un critère oublié dans la liste de l'implémenteur est le défaut le plus probable.
2. Pour **chaque** critère déclaré \`met\`, trouve dans le diff ce qui le tient. Si tu ne le
   trouves pas, il va dans \`overstated\`.
3. Les critères qui portent une commande vérifiable (\`grep -r "](/docs/" website/docs\` ne rend
   rien, \`pnpm build\` passe, un fichier a disparu), **fais-la tourner toi-même**. Ne crois pas
   la déclaration.
4. Le ticket a un *pourquoi* pour chaque critère. Cherche le cas où la lettre est respectée et
   l'intention manquée — c'est le mode d'échec propre à ces tickets.
5. Cherche les dégâts collatéraux : un fichier supprimé qu'un autre référençait encore, un test
   désactivé, un portail contourné, une modification hors du périmètre du ticket.

## Calibrer la sévérité — c'est là que le pilote s'est trompé

Sur le premier ticket, une ligne d'échafaudage Docusaurus laissée intacte
(un titre de page « Hello from … » resté tel quel) a été classée \`minor\` alors qu'un critère demandait
explicitement que ce fichier décrive le produit. Elle est passée. La règle est donc :

- **\`major\` = un critère d'acceptation n'est pas tenu.** La taille apparente du défaut
  n'entre pas en compte : une ligne suffit. Si tu peux nommer le critère, c'est \`major\`.
- **\`minor\` = aucun critère en jeu** — un résidu, un fichier orphelin, de la dette.
- **\`blocking\`** = portail rouge, régression, ou le ticket manque son objet.

Et pour chaque défaut, tranche le **périmètre** : est-il dans les critères de #${n} et les
fichiers qu'il touche (\`this_ticket\`), ou appartient-il à un autre ticket de la carte
(\`other_ticket\`, avec son numéro) ? Un défaut hors périmètre sera **routé**, pas réparé ici —
réparer le fichier d'un autre ticket à l'intérieur de celui-ci est de l'élargissement muet.

## Le verdict

\`safe_to_merge: false\` dès qu'il existe un défaut \`blocking\` **ou** \`major\`. Les \`minor\`
n'empêchent pas le merge : une étape de correction les traite juste avant.

Un \`flagged\` correctement déclaré par l'implémenteur n'est **pas** un défaut : c'est le système
qui fonctionne. Un \`overstated\` non déclaré, si — et il est \`major\` au minimum.
`

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'fixed', 'declined', 'gates_still_green'],
  properties: {
    issue: { type: 'integer' },
    fixed: {
      type: 'array',
      items: { type: 'string', description: 'le défaut réparé, et où' },
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why'],
        properties: {
          what: { type: 'string' },
          why: { type: 'string', description: 'hors périmètre (avec le ticket propriétaire), ou réparation non évidente' },
        },
      },
    },
    gates_still_green: { type: 'boolean' },
  },
}

const fixPrompt = (n, impl, minors) => `
Tu répares les défauts **mineurs** relevés sur la branche \`${impl.branch}\` (ticket #${n}) avant
son intégration. Le diff a déjà passé la relecture adversariale : aucun critère d'acceptation
n'est en jeu ici, il ne reste que de la propreté.

Place-toi **dans le worktree où elle est déjà sortie** — la branche y est checked out, aucun
autre répertoire ne peut la reprendre :

\`\`\`
cd ${impl.worktree_path}
git status -sb            # doit annoncer ${impl.branch}
\`\`\`

Si ce chemin n'existe plus, rends \`gates_still_green: true\` avec un \`declined\` disant que le
worktree a disparu, et ne touche à rien : la branche est intacte et partira au merge telle
qu'elle a été vérifiée.

## Les défauts

${JSON.stringify(minors, null, 2)}

## La règle de périmètre — elle prime sur l'envie de bien faire

Tu ne répares que ce qui tombe **dans les critères de #${n} ou dans les fichiers que ce diff
touche déjà**. Un défaut marqué \`scope: "other_ticket"\` appartient à un autre ticket de la
carte : tu le **déclines** en le nommant dans \`declined\`, avec son ticket propriétaire.

Réparer le fichier d'un autre ticket ici, c'est élargir le périmètre en silence — et c'est
précisément ce que la découpe en tickets existe pour empêcher. Le défaut n'est pas perdu : il
remonte dans le rapport de vague et sera routé.

Décline aussi tout défaut dont la réparation n'est **pas évidente** : ici on nettoie, on ne
conçoit pas.

## Après

Refais tourner les portails du ticket :

${impl.gates.map(g => '- `' + g.cmd + '`').join('\n')}

S'ils restent verts, committe : \`git commit -s -m "chore(<scope>): <sujet>" -m "Refs #${n}"\`.
S'ils cassent, **annule tes corrections** (\`git checkout -- .\` sur ce que tu viens de toucher)
et rends \`gates_still_green: false\` — la branche part au merge telle qu'elle était vérifiée,
ce qui est le résultat sûr.

Ne pousse rien.
`

const mergePrompt = (n, impl) => `
Intègre la branche \`${impl.branch}\` (ticket #${n}) sur \`${BASE}\`, dans le dépôt principal.

\`\`\`
git switch ${BASE}
git merge --no-ff ${impl.branch} -m "feat: <sujet du ticket> (#${n})"
\`\`\`

Puis refais tourner les portails du ticket **sur la base fusionnée** — un merge propre en
apparence peut casser ce qu'un frère de la même vague vient de poser :

${impl.gates.map(g => '- `' + g.cmd + '`').join('\n')}

Si un portail casse après le merge et que la réparation n'est pas évidente en une ou deux
modifications, **annule** (\`git merge --abort\`, ou \`git reset --hard HEAD~1\` si le merge est
déjà écrit) et rends \`merged: false\` avec la raison. Ne pousse rien : \`git push\` est interdit.

Rends un objet : { "issue": ${n}, "merged": true|false, "reason": "..." }.
`

// ---------------------------------------------------------------- implémenter + vérifier
phase('Implémenter')
log(`Vague : ${WAVE.map(n => '#' + n).join(', ')} — base ${BASE}`)

const results = await pipeline(
  WAVE,
  (n) => agent(implPrompt(n), {
    label: `impl:#${n}`,
    phase: 'Implémenter',
    isolation: 'worktree',
    schema: IMPL_SCHEMA,
  }),
  (impl, n) => {
    if (!impl || !impl.committed || !impl.base_ok) return { issue: n, impl, verdict: null, fix: null }
    return agent(verifyPrompt(n, impl), {
      label: `verify:#${n}`,
      phase: 'Vérifier',
      schema: VERDICT_SCHEMA,
    }).then(verdict => ({ issue: n, impl, verdict }))
  },
  (r, n) => {
    // Les `minor` du périmètre du ticket sont réparés avant l'intégration ; les
    // `other_ticket` remontent tels quels et seront routés dans le rapport de vague.
    if (!r || !r.verdict || !r.verdict.safe_to_merge) return { ...(r || { issue: n }), fix: null }
    const minors = r.verdict.defects.filter(d => d.severity === 'minor' && d.scope === 'this_ticket')
    if (!minors.length) return { ...r, fix: null }
    return agent(fixPrompt(n, r.impl, minors), {
      label: `fix:#${n}`,
      phase: 'Corriger',
      schema: FIX_SCHEMA,
    }).then(fix => ({ ...r, fix }))
  }
)

// ---------------------------------------------------------------- intégrer, en série
phase(MERGE ? 'Intégrer' : 'Conclure')

const merged = []
const held = []
const ready = []   // vérifié, prêt à fusionner par un humain
const routed = []   // défauts appartenant à un autre ticket de la carte

for (const r of results.filter(Boolean)) {
  const { issue, impl, verdict, fix } = r

  if (impl && impl.base_ok === false) {
    held.push({ issue, reason: 'mauvaise base — rien produit', summary: impl.summary })
    log(`#${issue} retenu : n'a pas pu partir de ${BASE}`)
    continue
  }
  if (!impl || !impl.committed) {
    held.push({ issue, reason: 'aucun commit produit', impl: impl || null })
    log(`#${issue} retenu : aucun commit produit`)
    continue
  }

  if (verdict) {
    for (const d of verdict.defects.filter(x => x.scope === 'other_ticket')) {
      routed.push({ from: issue, to: d.owner_issue || 0, severity: d.severity, what: d.what, where: d.where })
    }
  }
  if (fix) {
    for (const d of fix.declined) routed.push({ from: issue, to: 0, severity: 'minor', what: d.what, where: d.why })
  }

  // Un critère non tenu retient la fusion, même déclaré honnêtement. Le
  // vérificateur ne l'attrape pas : un `partial` assumé n'est ni un défaut ni
  // une surdéclaration. Un `impossible` qui nomme ce qu'il faut d'un humain
  // passe — c'est le signalement, pas la dérive.
  const unmet = unmetCriteria(impl)
  if (unmet.length && !ACK_UNMET.has(issue)) {
    held.push({
      issue,
      reason: 'critère(s) d’acceptation non tenu(s)',
      branch: impl.branch,
      worktree: impl.worktree_path,
      unmet: unmet.map(c => ({ status: c.status, text: c.text, evidence: c.evidence })),
      flagged: impl.flagged,
    })
    log(`#${issue} retenu : ${unmet.length} critère(s) non tenu(s) — ${unmet.map(c => c.status).join(', ')}`)
    continue
  }

  // Un `major` routé ailleurs retient la fusion tant qu'il n'est pas écrit sur
  // son ticket propriétaire — « routé » ne doit pas devenir un synonyme de
  // « oublié ». Il ne retient pas *pour toujours* : la trace est rendue, un
  // humain l'écrit, et la relance acquitte le ticket.
  const routedSerious = verdict
    ? verdict.defects.filter(d => d.scope === 'other_ticket' && d.severity !== 'minor')
    : []
  if (routedSerious.length && !ACK.has(issue)) {
    held.push({
      issue,
      reason: 'défaut majeur routé, pas encore écrit sur son ticket propriétaire',
      branch: impl.branch,
      worktree: impl.worktree_path,
      to_write: routedSerious.map(d => ({
        owner_issue: d.owner_issue || 0,
        severity: d.severity,
        what: d.what,
        where: d.where,
      })),
      flagged: impl.flagged,
    })
    log(`#${issue} retenu : ${routedSerious.length} défaut(s) majeur(s) à écrire sur ${routedSerious.map(d => '#' + (d.owner_issue || '?')).join(', ')} avant fusion`)
    continue
  }

  // Le seuil : `major` retient autant que `blocking`. Un critère d'acceptation non
  // tenu est un critère non tenu, quelle que soit la taille de la ligne en cause.
  if (!verdict || !verdict.safe_to_merge) {
    const serious = verdict ? verdict.defects.filter(d => d.severity !== 'minor') : []
    held.push({
      issue,
      reason: verdict ? 'vérification adversariale négative' : 'vérification indisponible',
      branch: impl.branch,
      worktree: impl.worktree_path,
      overstated: verdict ? verdict.overstated : ['vérification indisponible'],
      defects: serious,
      // **Le nom que `v5-repair.js` lit.** Un item retenu se passe tel quel à la
      // passe de réparation, et celle-ci attend `findings` : tant que la clé
      // s'appelait `defects` ici, la reprise partait sans constat — l'agent
      // recevait `[object Object]`, refaisait sa propre relecture et rendait une
      // branche « réparée » dont le défaut retenu tenait toujours (#708). Les
      // deux tableaux voyagent ensemble parce que la réparation doit solder les
      // critères surdéclarés autant que les défauts.
      findings: serious,
      flagged: impl.flagged,
    })
    log(`#${issue} retenu : ${serious.length} défaut(s) bloquant/majeur, branche ${impl.branch} conservée`)
    continue
  }

  if (!MERGE) {
    ready.push({
      issue,
      branch: impl.branch,
      worktree: impl.worktree_path,
      gates: impl.gates.map(g => g.cmd),
      flagged: impl.flagged,
      fixed: fix ? fix.fixed : [],
      summary: impl.summary,
    })
    log(`#${issue} vérifié et prêt : ${impl.branch}`)
    continue
  }

  const out = await agent(mergePrompt(issue, impl), {
    label: `merge:#${issue}`,
    phase: 'Intégrer',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['issue', 'merged', 'reason'],
      properties: {
        issue: { type: 'integer' },
        merged: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
  })

  if (out && out.merged) {
    merged.push({
      issue,
      branch: impl.branch,
      flagged: impl.flagged,
      fixed: fix ? fix.fixed : [],
      summary: impl.summary,
    })
    log(`#${issue} fusionné sur ${BASE}`)
  } else {
    held.push({ issue, reason: (out && out.reason) || 'merge échoué', branch: impl.branch, flagged: impl.flagged })
    log(`#${issue} retenu au merge : ${(out && out.reason) || 'raison inconnue'}`)
  }
}

log(`Vague terminée — ${ready.length} prêt(s), ${merged.length} fusionné(s), ${held.length} retenu(s), ${routed.length} à router`)

return {
  base: BASE,
  wave: WAVE,
  merged,
  ready,
  held,
  routed,
  merge_commands: ready.map(r =>
    `git switch ${BASE} && git merge --no-ff ${r.branch} -m "feat: <sujet> (#${r.issue})"`),
  details: results.filter(Boolean).map(r => ({
    issue: r.issue,
    branch: r.impl && r.impl.branch,
    worktree: r.impl && r.impl.worktree_path,
    summary: r.impl && r.impl.summary,
    criteria: r.impl && r.impl.criteria,
    gates: r.impl && r.impl.gates,
    flagged: r.impl && r.impl.flagged,
    verdict: r.verdict,
    fix: r.fix,
  })),
}

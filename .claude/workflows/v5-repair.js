export const meta = {
  name: 'v5-repair',
  description: 'Répare des branches v5 retenues par la relecture adversariale, re-vérifie à neuf, puis fusionne',
  whenToUse: "Après une vague v5 dont des tickets sont `held`. args = { base, items: [{issue, branch, worktree, findings}] }",
  phases: [
    { title: 'Réparer', detail: 'un agent par branche retenue, dans son worktree d’origine' },
    { title: 'Re-vérifier', detail: 'relecture adversariale à neuf, sans confiance dans la précédente' },
    { title: 'Intégrer', detail: 'merges --no-ff sérialisés' },
  ],
}

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { input = {} }
}

const BASE = (input && input.base) || 'preview/v5'
const ITEMS = (input && input.items) || []

// Même règle que `v5-wave.js` : un `major` routé vers un autre ticket retient la
// fusion tant qu'un humain ne l'a pas écrit là-bas. Relancer en listant ici les
// tickets acquittés.
const ACK = new Set((input && input.acknowledgedRouting) || [])

if (!ITEMS.length) {
  log(`Rien à réparer — args reçu : ${JSON.stringify(args)}`)
  return { merged: [], held: [], error: 'items vide' }
}

const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'addressed', 'declined', 'gates', 'committed', 'summary'],
  properties: {
    issue: { type: 'integer' },
    addressed: {
      type: 'array',
      description: 'un élément par constat (S1, S2, D1, D2…) que tu as traité',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'how', 'where'],
        properties: {
          id: { type: 'string', description: 'l’identifiant du constat dans le fichier : S1, D2, …' },
          how: { type: 'string' },
          where: { type: 'string', description: 'fichier:ligne' },
        },
      },
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'why'],
        properties: {
          id: { type: 'string' },
          why: { type: 'string', description: 'hors périmètre (avec le ticket propriétaire), ou exige une décision humaine' },
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
          output_tail: { type: 'string' },
        },
      },
    },
    committed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'safe_to_merge', 'unresolved', 'new_defects'],
  properties: {
    issue: { type: 'integer' },
    safe_to_merge: { type: 'boolean' },
    unresolved: {
      type: 'array',
      description: 'constats de la relecture précédente que la réparation n’a pas réellement soldés',
      items: { type: 'string' },
    },
    new_defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'scope', 'what', 'where'],
        properties: {
          severity: { enum: ['blocking', 'major', 'minor'] },
          scope: { enum: ['this_ticket', 'other_ticket'] },
          owner_issue: { type: 'integer' },
          what: { type: 'string' },
          where: { type: 'string' },
        },
      },
    },
  },
}

const repairPrompt = (it) => `
Tu répares la branche \`${it.branch}\` (ticket #${it.issue} du dépôt pbrissaud/suivi-bourse).
Elle a été **retenue** par une relecture adversariale : elle n'a pas été fusionnée, et elle ne
le sera qu'une fois ces constats soldés.

## Où travailler

\`\`\`
cd ${it.worktree}
git status -sb            # doit annoncer ${it.branch}
\`\`\`

La branche est déjà sortie dans ce worktree ; aucun autre répertoire ne peut la reprendre. Si
le chemin a disparu, rends \`committed: false\` en le disant, et ne touche à rien.

## Les constats

Lis **le fichier entier** avant d'écrire une ligne :

\`\`\`
${it.findings}
\`\`\`

Chaque constat porte un identifiant — \`S1\`, \`S2\` pour les critères surdéclarés, \`D1\`, \`D2\`
pour les défauts. Ta sortie les reprend un par un.

Relis aussi le ticket lui-même (\`gh issue view ${it.issue} --comments\`) et sa spec parente : un
constat se solde en tenant le critère, pas en faisant taire le symptôme.

## La règle qui gouverne cette passe

**Un défaut \`blocking\` ou \`major\` de périmètre \`this_ticket\` doit être soldé.** C'est la
raison d'être de la passe. Un critère surdéclaré se solde de deux façons, et les deux sont
recevables : soit tu le tiens pour de bon, soit tu le déclares honnêtement non tenu — mais
alors tu le dis dans \`declined\`, tu ne le laisses pas passer pour tenu.

**Un défaut \`other_ticket\` ne se répare pas ici.** Tu le déclines en nommant son ticket
propriétaire. Élargir le périmètre annule la découpe qui fait tenir la carte.

**Un constat qui exige une décision humaine se décline aussi** — avec la question à trancher.
Ne tranche pas à la place de l'humain sur une décision de produit.

## Les portails

Refais tourner tout ce qui concerne les fichiers touchés, **y compris ce que les portails
d'origine ne couvraient pas** — c'est par là que le défaut bloquant est passé la première fois :

- \`website/\` → \`cd website && pnpm install --frozen-lockfile && pnpm build\`
- \`app/src/\`, \`app/tests/\` → \`cd app && uv sync && uv run flake8 src/ --ignore=E501 && uv run pytest tests/\`
- \`app/web/\` → \`cd app/web && pnpm install && pnpm lint && pnpm build\`, et \`pnpm test\` s'il existe
- **si le diff touche \`app/Dockerfile\`, \`app/web/package.json\`, un lockfile ou un
  \`pnpm-workspace.yaml\`** → construis réellement l'image :
  \`cd app && docker build -t sb-repair-check .\` (ou, si docker est indisponible, reproduis à
  l'identique la couche d'installation et dis-le)

Tu ne maquilles jamais un portail.

## Committer

\`git commit -s -m "fix(<scope>): <sujet>" -m "Refs #${it.issue}"\`. Découpe par constat quand
c'est lisible.

Ta sortie est l'objet structuré. Sois exact : une relecture adversariale **à neuf** passe
derrière toi et ne fait aucune confiance à celle qui t'a précédé.
`

const reverifyPrompt = (it, rep) => `
Tu relis, en adversaire, la **réparation** de la branche \`${it.branch}\` (ticket #${it.issue}).

Cette branche a déjà été retenue une fois. Ton hypothèse par défaut est qu'une réparation faite
sous la pression d'une liste de constats solde les symptômes et manque les causes. Tu ne fais
**aucune confiance** à la relecture précédente : tu la refais.

\`\`\`
cd ${it.worktree}
git diff ${BASE}...${it.branch}
git log --oneline ${BASE}..${it.branch}
\`\`\`

Les constats d'origine : \`${it.findings}\`

Le réparateur déclare avoir traité : ${JSON.stringify(rep.addressed, null, 2)}
Et avoir décliné : ${JSON.stringify(rep.declined, null, 2)}
Portails : ${JSON.stringify(rep.gates)}

## Ce que tu vérifies

1. **Chaque constat d'origine, un par un.** Pour chaque \`addressed\`, trouve dans le diff ce qui
   le solde réellement. S'il est soldé en apparence seulement, il va dans \`unresolved\`.
2. **Les \`declined\` sont-ils légitimement déclinés ?** Un \`other_ticket\` doit vraiment
   appartenir à l'autre ticket ; une « décision humaine » doit vraiment en être une, et non un
   travail esquivé. Un déclin abusif va dans \`unresolved\`.
3. **Relis les critères d'acceptation à la source** (\`gh issue view ${it.issue}\`) et vérifie
   ceux que personne n'a encore contestés — la première relecture peut en avoir manqué.
4. **Fais tourner les portails toi-même**, dont celui qui avait laissé passer le défaut
   bloquant. Ne crois pas les déclarations.
5. Cherche ce que la réparation a **cassé** : une correction sous contrainte introduit des
   régressions.

## Sévérité, calibrée

- \`major\` = un critère d'acceptation n'est pas tenu. La taille de la ligne en cause n'entre
  pas en compte ; si tu peux nommer le critère, c'est \`major\`.
- \`minor\` = aucun critère en jeu.
- \`blocking\` = portail rouge, régression, ou le ticket manque son objet.

\`safe_to_merge: false\` dès qu'il reste un \`unresolved\`, ou un \`new_defect\` \`blocking\` ou
\`major\` de périmètre \`this_ticket\`.
`

const mergePrompt = (it, rep) => `
Intègre la branche \`${it.branch}\` (ticket #${it.issue}) sur \`${BASE}\`, **depuis le dépôt
principal** \`/Users/paul/Workspace/suivi-bourse\` (pas depuis un worktree) :

\`\`\`
cd /Users/paul/Workspace/suivi-bourse
git switch ${BASE}
git merge --no-ff ${it.branch} -m "feat: <sujet du ticket> (#${it.issue})"
\`\`\`

Puis refais tourner les portails **sur la base fusionnée** — un frère de la même vague vient
peut-être d'y poser quelque chose d'incompatible :

${rep.gates.map(g => '- `' + g.cmd + '`').join('\n')}

Si un portail casse après le merge et que la réparation n'est pas évidente en une ou deux
modifications, **annule** (\`git merge --abort\`, ou \`git reset --hard HEAD~1\` si le merge est
déjà écrit) et rends \`merged: false\` avec la raison. Ne pousse rien.

Rends : { "issue": ${it.issue}, "merged": true|false, "reason": "..." }.
`

phase('Réparer')
log(`Réparation : ${ITEMS.map(i => '#' + i.issue).join(', ')} — base ${BASE}`)

const results = await pipeline(
  ITEMS,
  (it) => agent(repairPrompt(it), { label: `repair:#${it.issue}`, phase: 'Réparer', schema: REPAIR_SCHEMA }),
  (rep, it) => {
    if (!rep || !rep.committed) return { it, rep, verdict: null }
    return agent(reverifyPrompt(it, rep), {
      label: `reverify:#${it.issue}`,
      phase: 'Re-vérifier',
      schema: VERDICT_SCHEMA,
    }).then(verdict => ({ it, rep, verdict }))
  }
)

phase('Intégrer')

const merged = []
const held = []
const routed = []

for (const r of results.filter(Boolean)) {
  const { it, rep, verdict } = r

  if (!rep || !rep.committed) {
    held.push({ issue: it.issue, reason: 'réparation sans commit', summary: rep && rep.summary })
    log(`#${it.issue} toujours retenu : aucun commit de réparation`)
    continue
  }

  for (const d of rep.declined) routed.push({ from: it.issue, id: d.id, why: d.why })
  if (verdict) {
    for (const d of verdict.new_defects.filter(x => x.scope === 'other_ticket')) {
      routed.push({ from: it.issue, to: d.owner_issue || 0, severity: d.severity, what: d.what, where: d.where })
    }
  }

  const serious = verdict
    ? verdict.new_defects.filter(d => d.scope === 'this_ticket' && d.severity !== 'minor')
    : []

  const routedSerious = verdict
    ? verdict.new_defects.filter(d => d.scope === 'other_ticket' && d.severity !== 'minor')
    : []
  if (routedSerious.length && !ACK.has(it.issue)) {
    held.push({
      issue: it.issue,
      reason: 'défaut majeur routé, pas encore écrit sur son ticket propriétaire',
      branch: it.branch,
      worktree: it.worktree,
      to_write: routedSerious.map(d => ({
        owner_issue: d.owner_issue || 0,
        severity: d.severity,
        what: d.what,
        where: d.where,
      })),
    })
    log(`#${it.issue} retenu : ${routedSerious.length} défaut(s) majeur(s) à écrire sur ${routedSerious.map(d => '#' + (d.owner_issue || '?')).join(', ')} avant fusion`)
    continue
  }

  if (!verdict || !verdict.safe_to_merge) {
    held.push({
      issue: it.issue,
      reason: verdict ? 'la réparation n’a pas soldé' : 'relecture indisponible',
      branch: it.branch,
      worktree: it.worktree,
      unresolved: verdict ? verdict.unresolved : ['relecture indisponible'],
      new_defects: serious,
      declined: rep.declined,
    })
    log(`#${it.issue} toujours retenu : ${verdict ? verdict.unresolved.length : '?'} non soldé(s), ${serious.length} nouveau(x)`)
    continue
  }

  const out = await agent(mergePrompt(it, rep), {
    label: `merge:#${it.issue}`,
    phase: 'Intégrer',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['issue', 'merged', 'reason'],
      properties: { issue: { type: 'integer' }, merged: { type: 'boolean' }, reason: { type: 'string' } },
    },
  })

  if (out && out.merged) {
    merged.push({ issue: it.issue, branch: it.branch, addressed: rep.addressed, declined: rep.declined, summary: rep.summary })
    log(`#${it.issue} fusionné sur ${BASE}`)
  } else {
    held.push({ issue: it.issue, reason: (out && out.reason) || 'merge échoué', branch: it.branch })
    log(`#${it.issue} retenu au merge : ${(out && out.reason) || 'raison inconnue'}`)
  }
}

log(`Réparation terminée — ${merged.length} fusionné(s), ${held.length} retenu(s), ${routed.length} à router`)

return {
  base: BASE,
  merged,
  held,
  routed,
  details: results.filter(Boolean).map(r => ({
    issue: r.it.issue,
    branch: r.it.branch,
    worktree: r.it.worktree,
    repair: r.rep,
    verdict: r.verdict,
  })),
}

export const meta = {
  name: 'v5-verify',
  description: 'Relit une branche v5 en adversaire, sans déclaration d’implémenteur — pour du travail récupéré ou écrit à la main',
  whenToUse: "Quand une branche existe sans être passée par v5-wave : session interrompue, travail manuel, PR extérieure. args = { base, items: [{issue, branch, worktree}] }",
  phases: [
    { title: 'Relire', detail: 'un agent par branche, critères lus à la source' },
  ],
}

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch (e) { input = {} }
}

const BASE = (input && input.base) || 'preview/v5'
const ITEMS = (input && input.items) || []

if (!ITEMS.length) {
  log(`Rien à relire — args reçu : ${JSON.stringify(args)}`)
  return { verdicts: [], error: 'items vide' }
}

// La différence avec la relecture de `v5-wave` : il n'y a **pas** de
// déclaration d'implémenteur à contredire. C'est plus dur et plus honnête — le
// relecteur établit lui-même l'état de chaque critère depuis le diff, sans
// liste à cocher qui oriente son regard.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'safe_to_merge', 'criteria', 'defects'],
  properties: {
    issue: { type: 'integer' },
    safe_to_merge: { type: 'boolean' },
    criteria: {
      type: 'array',
      description: 'un élément par case à cocher du ticket, dans l’ordre, établi par toi depuis le diff',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'status', 'evidence'],
        properties: {
          text: { type: 'string', description: 'le critère, abrégé à 100 caractères' },
          status: { enum: ['met', 'partial', 'not_met', 'unverifiable'] },
          evidence: {
            type: 'string',
            description: 'fichier:ligne, ou la commande que tu as exécutée et ce qu’elle a rendu',
          },
        },
      },
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
              'blocking = portail rouge, régression, le ticket manque son objet. ' +
              'major = un critère d’acceptation n’est pas tenu, quelle que soit la taille de la ligne en cause. ' +
              'minor = résidu, propreté, dette — aucun critère en jeu.',
          },
          scope: { enum: ['this_ticket', 'other_ticket'] },
          owner_issue: { type: 'integer' },
          what: { type: 'string' },
          where: { type: 'string' },
        },
      },
    },
    needs_human: {
      type: 'array',
      description: 'décisions que le diff a prises et qui ne sont pas les tiennes à confirmer',
      items: { type: 'string' },
    },
  },
}

const prompt = (it) => `
Tu relis, en adversaire, la branche \`${it.branch}\` (ticket #${it.issue} du dépôt
pbrissaud/suivi-bourse). Elle n'est **pas** passée par le pipeline habituel : personne ne t'a
remis de déclaration d'implémenteur, et il n'y a donc aucune liste à cocher pour orienter ton
regard. C'est à toi d'établir l'état de **chaque** critère depuis le diff.

${it.origin ? `Origine de ce travail : ${it.origin}\n` : ''}
## Où travailler

\`\`\`
cd ${it.worktree}
git log --oneline ${BASE}..${it.branch}
git diff ${BASE}...${it.branch}
\`\`\`

## Ce que tu fais

1. \`gh issue view ${it.issue} --comments\` — les critères **à la source**, et les commentaires :
   certains portent du travail ajouté après coup.
2. Lis la spec parente nommée en \`## Parent\` et les ADR qu'elle cite (\`docs/adr/\`). Règle
   d'arbitrage : \`CLAUDE.md\` décrit l'état en place, les ADR décrivent la destination — quand
   les deux se contredisent, **l'ADR gagne**.
3. Pour **chaque** critère, établis son état et **prouve-le** : \`fichier:ligne\`, ou la commande
   que tu as exécutée et ce qu'elle a rendu. Un critère que tu ne peux pas établir se déclare
   \`unverifiable\` — ne le devine pas.
4. **Fais tourner les portails toi-même**, et n'en crois aucun sur parole :
   - \`uv sync && uv run flake8 src/application src/api --ignore=E501 && uv run pytest tests/\`
   - si le diff touche \`Dockerfile\`, un lockfile ou \`pnpm-workspace.yaml\` :
     \`docker build -t sb-verify-${it.issue} .\`
   - si le diff touche \`website/\` : \`cd website && pnpm install --frozen-lockfile && pnpm build\`
   - **et le portail que personne n'a pensé à écrire** : pour chaque fichier de configuration
     que ce diff touche, demande-toi *quel outil le consomme réellement*, et fais tourner
     celui-là. Trois défauts de cette carte sont passés par ce trou — un \`pnpm-workspace.yaml\`
     absent d'une couche Docker pendant que quatre portails restaient verts, un trailer
     \`Release-As\` qu'un parseur écarte en entier, un glob que Crowdin refuse de compiler.
5. Cherche ce qui **n'est pas** dans les critères : une régression, un fichier supprimé qu'un
   autre référence encore, une décision de produit prise en passant. Ce diff vient d'une
   session interrompue — ce qu'elle allait faire ensuite n'est écrit nulle part.

## Sévérité

- \`major\` = **un critère d'acceptation n'est pas tenu.** La taille apparente du défaut n'entre
  pas en compte : si tu peux nommer le critère, c'est \`major\`.
- \`minor\` = aucun critère en jeu.
- \`blocking\` = portail rouge, régression, ou le ticket manque son objet.

Un défaut qui appartient à un autre ticket de la carte se marque \`other_ticket\` avec son
numéro : il sera routé, jamais réparé ici.

\`safe_to_merge: false\` dès qu'il reste un \`blocking\` ou un \`major\` de périmètre
\`this_ticket\`, ou un critère \`partial\` / \`not_met\`.

Ne modifie rien, ne committe rien, ne fusionne rien. Tu relis.
`

phase('Relire')
log(`Relecture : ${ITEMS.map(i => '#' + i.issue).join(', ')} — base ${BASE}`)

const verdicts = await parallel(ITEMS.map(it => () =>
  agent(prompt(it), { label: `verify:#${it.issue}`, phase: 'Relire', schema: VERDICT_SCHEMA })
    .then(v => ({ it, verdict: v }))
))

const ok = []
const held = []
const routed = []

for (const r of verdicts.filter(Boolean)) {
  const { it, verdict } = r
  if (!verdict) { held.push({ issue: it.issue, reason: 'relecture indisponible', branch: it.branch }); continue }

  for (const d of verdict.defects.filter(x => x.scope === 'other_ticket')) {
    routed.push({ from: it.issue, to: d.owner_issue || 0, severity: d.severity, what: d.what, where: d.where })
  }

  const serious = verdict.defects.filter(d => d.scope === 'this_ticket' && d.severity !== 'minor')
  const unmet = verdict.criteria.filter(c => c.status === 'partial' || c.status === 'not_met')

  const entry = {
    issue: it.issue,
    branch: it.branch,
    worktree: it.worktree,
    unmet,
    unverifiable: verdict.criteria.filter(c => c.status === 'unverifiable'),
    defects: serious,
    // **Le nom que `v5-repair.js` lit**, comme dans `v5-wave.js` et pour la même
    // raison : un item retenu se passe tel quel à la passe de réparation, qui
    // attend `findings`. Sous le seul nom `defects` elle recevait
    // `[object Object]`, refaisait sa propre relecture et rendait une branche
    // « réparée » dont le défaut retenu tenait toujours.
    findings: serious,
    minors: verdict.defects.filter(d => d.scope === 'this_ticket' && d.severity === 'minor'),
    needs_human: verdict.needs_human || [],
    criteria: verdict.criteria,
  }

  if (verdict.safe_to_merge && !serious.length && !unmet.length) {
    ok.push(entry)
    log(`#${it.issue} tient : ${verdict.criteria.length} critères établis, aucun défaut sérieux`)
  } else {
    held.push(entry)
    log(`#${it.issue} retenu : ${unmet.length} critère(s) non tenu(s), ${serious.length} défaut(s) sérieux`)
  }
}

log(`Relecture terminée — ${ok.length} prêt(s), ${held.length} retenu(s), ${routed.length} à router`)

return {
  base: BASE,
  ready: ok,
  held,
  routed,
  merge_commands: ok.map(r =>
    `git switch ${BASE} && git merge --no-ff ${r.branch} -m "feat: <sujet> (#${r.issue})"`),
}

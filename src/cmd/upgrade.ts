/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
import { prepareEnvironment } from 'src/common/cli'
import { hfValues } from 'src/common/hf'
import { getDeploymentState, setDeploymentState } from 'src/common/k8s'
import { getFilename, guccify, loadYaml, rootDir, semverCompare } from 'src/common/utils'
import { getCurrentVersion } from 'src/common/values'
import { BasicArguments, setParsedArgs } from 'src/common/yargs'
import { Argv } from 'yargs'
import { $, cd } from 'zx'

const cmdName = getFilename(__filename)

interface Arguments {
  dryRun?: boolean
  release?: string
  when: string
}

interface CommandArguments extends BasicArguments {
  dryRun?: boolean
  r?: string
  release?: string
  w?: string
  when?: string
}

interface Upgrade {
  version: string
  releases?: Record<string, string[]>
  pre?: string[]
  post?: string[]
}

export type Upgrades = Array<Upgrade>

// select upgrades after semver version, and always select upgrade with version "dev" for dev purposes
function filterUpgrades(version: string, upgrades: Upgrades): Upgrades {
  return upgrades.filter((c) => c.version === 'dev' || semverCompare(version, c.version))
}

async function execute(d: typeof console, dryRun: boolean, operations: string[], values: Record<string, any>) {
  for (const o of operations) {
    const matches: string[] = []
    const opStr = o.replace(/(\$\([^)]*\)|`[^`]*`)/g, (_, token: string) => {
      matches.push(token)
      return `T${matches.length - 1}X`
    })
    const op = (await guccify(opStr, values))
      .replaceAll(/do\W?\n/g, 'do ')
      .replaceAll('\n', ';')
      .replaceAll(/T([0-9]+)X/g, (match, token) => matches[token])
    d[dryRun ? 'log' : 'info'](`operation: ${op}`)
    if (dryRun) return
    const res = await $`${op}`
    if (res.stdout) d.log(res.stdout)
    if (res.stderr) d.error(res.stderr)
  }
}

/**
 * Checks if any operations need to be ran for releases and executes those.
 */
export const upgrade = async ({ dryRun = false, release, when }: Arguments): Promise<void> => {
  const d = console // wrapped stream created by terminal(... is not showing
  const upgrades: Upgrades = (await loadYaml(`${rootDir}/upgrades.yaml`))?.operations
  const prevVersion: string = (await getDeploymentState()).version ?? '0.1.0'
  const values = (await hfValues()) as Record<string, any>
  d.info(`Current version of otomi: ${prevVersion}`)
  const filteredUpgrades = filterUpgrades(prevVersion, upgrades)
  if (filteredUpgrades.length) {
    cd(rootDir)
    const q = $.quote
    $.quote = (v) => v
    for (let i = 0; i < filteredUpgrades.length; i++) {
      const c: Upgrade = filteredUpgrades[i]
      if (!release) {
        // before everything
        if (c[when]) {
          d.info(`Upgrade records detected for version ${c.version}`)
          await execute(d, dryRun, c[when] as string[], values)
        }
      } else if (c.releases?.[release]) {
        // just in time before a release gets synced
        const r = c.releases[release]
        if (r[when]) {
          d.info(`Upgrade records detected for version ${c.version}, release: ${release}`)
          await execute(d, dryRun, r[when] as string[], values)
        }
      }
    }
    $.quote = q
    // set latest version deployed in configmap
    const version = await getCurrentVersion()
    await setDeploymentState({ version })
  } else d.info('No upgrade operations detected, skipping')
}

export const module = {
  command: cmdName,
  hidden: true,
  describe: 'Upgrade resources to conform to new otomi version',
  builder: (parser: Argv): Argv =>
    parser.options({
      'dry-run': {
        alias: ['d'],
        boolean: true,
        default: false,
        hidden: true,
      },
      release: {
        alias: ['r'],
        type: 'string',
        hidden: true,
      },
      when: {
        alias: ['w'],
        type: 'string',
        hidden: true,
      },
    }),

  handler: async (argv: CommandArguments): Promise<void> => {
    setParsedArgs(argv)
    await prepareEnvironment({ skipAllPreChecks: true })
    await upgrade(argv as Arguments)
  },
}

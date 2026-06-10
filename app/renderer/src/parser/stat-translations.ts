import { CLIENT_STRINGS as _$, STAT_BY_MATCH_STR_V2, STATS_ITERATOR } from '@/assets/data'
import type { StatMatcher, Stat, StatGroup } from '@/assets/data'
import type { ModifierType } from './modifiers'
import { type ItemCategory, ARMOUR, WEAPON, HEIST_EQUIPMENT } from './meta'

// This file is a little messy and scary,
// but that's how stats translations are parsed :-D

const LOCALIZED_PAREN_LEFT = /^\s*(?:\(|（)/
const LOCALIZED_PAREN_RIGHT = /(?:\)|）)\s*$/

export interface ParsedStat {
  readonly stat: Stat
  readonly translation: StatMatcher
  roll?: {
    unscalable: boolean
    legacy?: true
    dp: boolean
    value: number
    min: number
    max: number
  }
}

interface StatString {
  string: string
  unscalable: boolean
}

function aptDebugIsComplexStatCase (value: string | undefined): boolean {
  // Temporary stat-translation trace: log all placeholder/lookup/resolve paths without narrowing.
  // Keep the existing call sites so this debug patch is easy to revert.
  return true
}

function aptDebugStatSummary (stat: Stat): Record<string, unknown> {
  return {
    ref: stat.ref,
    tradeIds: stat.trade?.ids,
    matcherCount: stat.matchers?.length,
  }
}

export function * linesToStatStrings (lines: string[]): Generator<StatString, string[], boolean> {
  const notParsedLines: string[] = []

  let reminderString = false

  outer:
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].match(LOCALIZED_PAREN_LEFT)) {
      reminderString = true
    }
    if (reminderString && lines[start].match(LOCALIZED_PAREN_RIGHT)) {
      reminderString = false
      continue
    }
    if (reminderString) {
      continue
    }

    for (let end = start; end < lines.length; end += 1) {
      let str = lines.slice(start, end + 1).join('\n')

      const unscalable = str.endsWith(_$.UNSCALABLE_VALUE)
      if (unscalable) {
        str = str.slice(0, -_$.UNSCALABLE_VALUE.length)
      }

      if (aptDebugIsComplexStatCase(str)) {
        console.log('[APT DEBUG] linesToStatStrings yield', {
          lines,
          start,
          end,
          candidate: str,
          unscalable,
        })
      }

      const isParsed: boolean = yield { string: str, unscalable }

      if (aptDebugIsComplexStatCase(str)) {
        console.log('[APT DEBUG] linesToStatStrings feedback', {
          candidate: str,
          isParsed,
        })
      }

      if (isParsed) {
        start += (end - start)
        continue outer
      }
    }
    notParsedLines.push(lines[start])
  }
  return notParsedLines.filter(line => line.length)
}

const PLACEHOLDER_MAP = [
  // 0 # -> max 0 #
  [[]],
  // 1 # -> max 1 #
  [[0], []],
  // 2 # -> max 2 #
  [[0, 1], [0], [1], []],
  // 3 # -> max 2 #
  [[0, 1, 2], [1, 2], [0, 2], [0, 1], [2], [1], [0]],
  // 4 # -> max 2 #
  [[0, 1, 2, 3], [1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2], [2, 3], [1, 3], [1, 2], [0, 3], [0, 2], [0, 1]]
]

function * _statPlaceholderGenerator (stat: string) {
  const matches: Array<{
    roll: number
    rollStr: string
    decimal: boolean
    bounds?: { min: number, max: number }
  }> = []
  const withPlaceholders = stat
    .replace(/\(\)/gm, '') // when GGG didn't provide advanced desc, like in "Passives in Radius of Wicked Ward() can be Allocated"
    .replace(
      /(?<sign>[+-]?)(?<value>\d+(?:\.\d+)?)(?:\((?<min>.[^)-]*)(?:-(?<max>[^)]+))?\))?/gm,
      (
        _,
        sign: string,
        roll: string,
        min?: string,
        max?: string
      ) => {
      if (min != null && max == null) {
        // example: Sextant "# uses remaining", legacy rolls
        max = min
      }

      const signedRoll = `${sign}${roll}`

      const captured: typeof matches[number] = {
        roll: Number(signedRoll),
        rollStr: roll,
        decimal: roll.includes('.') || min?.includes('.') || max?.includes('.') || false,
        bounds: { min: Number(min), max: Number(max) }
      }

      matches.push(captured)

      if (Number.isNaN(captured.bounds!.min) || Number.isNaN(captured.bounds!.max)) {
        captured.bounds = undefined
        return (min != null) ? `#(${min}-${max})` : '#'
      } else {
        return `${sign}#`
      }
    })

  if (matches.length < PLACEHOLDER_MAP.length) {
    for (const replacements of PLACEHOLDER_MAP[matches.length]) {
      let idx = -1
      const replaced = withPlaceholders.replace(/#/gm, () => {
        idx += 1
        return replacements.includes(idx)
          ? matches[idx].rollStr
          : '#'
      })

      yield {
        stat: replaced,
        values: matches
          .filter((_, idx) => !replacements.includes(idx)) as
            Array<Pick<typeof matches[number], 'roll' | 'bounds' | 'decimal'>>
      }

      if (replaced.includes('#')) {
        const oppositeSignReplaced = replaced
          .replace(/\+#/gm, '{PLUS_PLACEHOLDER}')
          .replace(/-#/gm, '+#')
          .replace(/\{PLUS_PLACEHOLDER\}/gm, '-#')

        if (oppositeSignReplaced !== replaced) {
          yield {
            stat: oppositeSignReplaced,
            values: matches
              .filter((_, idx) => !replacements.includes(idx)) as
                Array<Pick<typeof matches[number], 'roll' | 'bounds' | 'decimal'>>
          }
        }

        const signlessReplaced = replaced.replace(/[+-]#/gm, '#')

        if (signlessReplaced !== replaced) {
          yield {
            stat: signlessReplaced,
            values: matches
              .filter((_, idx) => !replacements.includes(idx)) as
                Array<Pick<typeof matches[number], 'roll' | 'bounds' | 'decimal'>>
          }
        }
      }    }
  }

  // fallback to exact stat text, without any placeholders
  // N # -> max 0 #
  yield { stat, values: [] }
}

function escapeRegExp (value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tryParseTranslation (
  stat: StatString,
  modType: ModifierType,
  itemCategory: ItemCategory | undefined
): ParsedStat | undefined {
  const aptDebugEnabled = aptDebugIsComplexStatCase(stat.string)

  if (aptDebugEnabled) {
    console.log('[APT DEBUG] tryParseTranslation ENTER', {
      input: stat,
      modType,
      itemCategory,
    })
  }

  for (const combination of _statPlaceholderGenerator(stat.string)) {
    if (aptDebugEnabled || aptDebugIsComplexStatCase(combination.stat)) {
      console.log('[APT DEBUG] tryParseTranslation combination', {
        input: stat.string,
        combination,
      })
    }
    const lookupCandidates = [
      { stat: combination.stat, negateRoll: false },
      { stat: combination.stat.replace('低下する', '増加する'), negateRoll: combination.stat.includes('低下する') },
      { stat: combination.stat.replace('減少する', '増加する'), negateRoll: combination.stat.includes('減少する') }
    ].filter((candidate, idx, self) =>
      candidate.stat !== combination.stat || idx === 0
    ).filter((candidate, idx, self) =>
      self.findIndex(other => other.stat === candidate.stat) === idx
    )

    for (const lookup of lookupCandidates) {
      let values = combination.values.map(value => ({
        ...value,
        bounds: value.bounds
          ? { ...value.bounds }
          : undefined
      }))

      if (lookup.negateRoll) {
        for (const value of values) {
          value.roll *= -1
          if (value.bounds) {
            value.bounds.min *= -1
            value.bounds.max *= -1
          }
        }
      }

      const found = findAndResolveTranslation({
        matchStr: lookup.stat,
        modType: modType,
        itemCategory: itemCategory,
        roll: (values.length === 1) ? values[0].roll : undefined
      })

      if (aptDebugEnabled || aptDebugIsComplexStatCase(lookup.stat)) {
        console.log('[APT DEBUG] tryParseTranslation lookup result', {
          input: stat.string,
          lookup,
          values,
          found: found ? {
            stat: aptDebugStatSummary(found.stat),
            matcher: found.matcher,
          } : undefined,
          supportsModType: found ? (modType in (found.stat.trade?.ids ?? {})) : false,
        })
      }

    if (!found || !(modType in (found.stat.trade?.ids ?? {}))) {
        continue
    }

    if (found.stat.trade.option && found.matcher.value != null) {
      return {
        stat: found.stat,
        translation: found.matcher,
        roll: {
          unscalable: stat.unscalable,
          dp: false,
          value: found.matcher.value as any,
          min: found.matcher.value as any,
          max: found.matcher.value as any
        } as any
      }
    }
    
    // Modifiers must be upgraded to the new values with a Divine Orb
    let legacyStatRolls = false

    if (found.matcher.negate) {
      for (const stat of values) {
        stat.roll *= -1
        if (stat.bounds) {
          stat.bounds.min *= -1
          stat.bounds.max *= -1
        }
      }
    }

    if (found.stat.ref === '# uses remaining') {
      const uses = values[0]
      uses.bounds = {
        min: 1,
        max: uses.bounds?.max ?? uses.roll
      }
    }

    for (const stat of values) {
      if (!stat.bounds) continue

      if (stat.bounds.min > stat.bounds.max) {
        // some stats granted by legacy Modifiers (not legacy rolls)
        // can have same stat translations as granted by new Modifiers
        // but swapped translation strings for positive and negative rolls
        stat.bounds = {
          max: stat.bounds.min,
          min: stat.bounds.max
        }
        // don't consider them as a legacy rolls
      }

      if (stat.roll > stat.bounds.max) {
        stat.bounds.max = stat.roll
        legacyStatRolls = true
      }
      if (stat.roll < stat.bounds.min) {
        stat.bounds.min = stat.roll
        legacyStatRolls = true
      }
    }

    if (!values.length && found.matcher.value) {
      values = [{
        roll: found.matcher.value,
        decimal: false,
        bounds: {
          min: found.matcher.value,
          max: found.matcher.value
        }
      }]
    }

    return {
      stat: found.stat,
      translation: found.matcher,
      roll: values.length
        ? {
            unscalable: stat.unscalable,
            legacy: legacyStatRolls || undefined,
            dp: found.stat.dp || values.some(stat => stat.decimal),
            value: getRollOrMinmaxAvg(values.map(stat => stat.roll)),
            min: getRollOrMinmaxAvg(values.map(stat => stat.bounds?.min ?? stat.roll)),
            max: getRollOrMinmaxAvg(values.map(stat => stat.bounds?.max ?? stat.roll))
          }
        : undefined
    }
  }
  }
}

export function getRollOrMinmaxAvg (values: number[]): number {
  if (values.length === 2) {
    return (values[0] + values[1]) / 2
  } else {
    return values[0]
  }
}

interface FindResolveParams {
  matchStr: string
  modType: ModifierType
  itemCategory: ItemCategory | undefined
  roll: number | undefined
}

function optionMatcherToRegex (matcher: string): RegExp | null {
  if ((matcher.match(/#/g) ?? []).length !== 1) return null

  const escaped = escapeRegExp(matcher)
  const pattern = '^' + escaped.replace('#', '(.+?)') + '$'

  return new RegExp(pattern)
}

function findOptionTranslation (
  matchStr: string,
  modType: ModifierType
): { matcher: StatMatcher, stat: Stat } | undefined {
  for (const stat of STATS_ITERATOR('')) {
    if (!stat.trade.option) continue
    if (!(modType in stat.trade.ids)) continue

    for (const matcher of stat.matchers) {
      const regex = optionMatcherToRegex(matcher.string)
      if (!regex) continue

      const match = regex.exec(matchStr)
      if (match) {
        const optionValue = match[1].trim()

        return {
          stat,
          matcher: {
            ...matcher,
            string: matchStr,
            value: optionValue as any
          }
        }
      }
    }
  }

  return undefined
}

function statSupportsModifierType (
  stat: Stat,
  modType: ModifierType
): boolean {
  return modType in (stat.trade?.ids ?? {})
}

function findMatcherInStat (
  stat: Stat,
  matchStr: string
): StatMatcher | undefined {
  return stat.matchers.find(m =>
    m.string === matchStr || m.advanced === matchStr)
}

function findTranslationByMatcherAndModType (
  matchStr: string,
  modType: ModifierType
): { matcher: StatMatcher, stat: Stat } | undefined {
  for (const stat of STATS_ITERATOR('')) {
    if (!statSupportsModifierType(stat, modType)) continue

    const matcher = findMatcherInStat(stat, matchStr)
    if (!matcher) continue

    return { stat, matcher }
  }

  return undefined
}

function findAndResolveTranslation (
  params: FindResolveParams
): { matcher: StatMatcher, stat: Stat } | undefined {
  const { matchStr, modType } = params
  const aptDebugEnabled = aptDebugIsComplexStatCase(matchStr)

  const statOrGroup = STAT_BY_MATCH_STR_V2(matchStr)

  if (aptDebugEnabled) {
    console.log('[APT DEBUG] findAndResolveTranslation lookup', {
      params,
      foundKind: !statOrGroup ? 'none' : ('stats' in statOrGroup ? 'group' : 'stat'),
      found: statOrGroup
        ? ('stats' in statOrGroup
            ? {
                resolve: statOrGroup.resolve,
                stats: statOrGroup.stats.map(aptDebugStatSummary),
              }
            : aptDebugStatSummary(statOrGroup))
        : undefined,
    })
  }

  if (!statOrGroup) {
    const optionFound = findOptionTranslation(matchStr, modType)
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] findAndResolveTranslation option fallback', {
        params,
        found: optionFound ? {
          stat: aptDebugStatSummary(optionFound.stat),
          matcher: optionFound.matcher,
        } : undefined,
      })
    }
    return optionFound
  }

  let stat: Stat | undefined
  if (!('stats' in statOrGroup)) {
    stat = statOrGroup
  } else {
    stat = _resolveTranslation(statOrGroup, params)
  }

  if (!stat) {
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] findAndResolveTranslation unresolved', { params })
    }
    return undefined
  }

//  console.log('[MATCHERS]', {matchStr,matchers: stat.matchers})

  const matcher = findMatcherInStat(stat, matchStr)
  if (!matcher) {
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] findAndResolveTranslation matcher missing', {
        params,
        selected: aptDebugStatSummary(stat),
        selectedMatchers: stat.matchers,
      })
    }
    return undefined
  }

  if (statSupportsModifierType(stat, modType)) {
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] findAndResolveTranslation selected', {
        params,
        selected: aptDebugStatSummary(stat),
        matcher,
      })
    }
    return { stat, matcher }
  }

  // Same localized matcher can exist for multiple trade id groups.
  // Example:
  //   プレフィックスモッド #個
  //     pseudo:   # Prefix Modifiers
  //     implicit: +# Prefix Modifier allowed
  //
  // If the fast lookup returns the wrong group first, keep searching for
  // another stat with the same matcher and a trade id matching the actual
  // in-game modifier type.
  return findTranslationByMatcherAndModType(matchStr, modType)
}

export function _resolveTranslation (
  statGroup: StatGroup,
  params: FindResolveParams
): Stat | undefined {
  const { resolve, stats } = statGroup
  const { matchStr, modType, itemCategory, roll } = params
  const aptDebugEnabled = aptDebugIsComplexStatCase(matchStr)

  if (aptDebugEnabled) {
    console.log('[APT DEBUG] _resolveTranslation ENTER', {
      params,
      resolve,
      stats: stats.map(aptDebugStatSummary),
    })
  }
if (resolve.strat === 'select') {
  // give priority to exact item category match
  let idx = resolve.test.findIndex(expected => expected !== null &&
    testItemCategory(itemCategory ?? null, expected))

  // fallback to generic stat
  if (idx === -1) {
    idx = resolve.test.indexOf(null)
  }

  if (idx === -1) {
    return undefined
  }

  const selected = stats[idx]

  // If selected stat does not actually have this matcher,
  // fallback to any stat in the group that has the requested matcher.
  if (
    !selected.matchers.some(m =>
      m.string === matchStr || m.advanced === matchStr)
  ) {
    return stats.find(stat =>
      stat.matchers.some(m =>
        m.string === matchStr || m.advanced === matchStr))
  }

  return selected
}

  const onTradeStats = stats.filter(stat => (modType in stat.trade.ids))
  if (onTradeStats.length === 1) {
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] _resolveTranslation single onTradeStat', {
        selected: aptDebugStatSummary(onTradeStats[0]),
      })
    }
    return onTradeStats[0]
  }

  if (resolve.strat === 'trivial-merge') {
    const withMatchStr = (matchStr.length)
      ? onTradeStats.filter(stat =>
          stat.matchers.some(m => m.string === matchStr || m.advanced === matchStr))
      : onTradeStats
    if (!withMatchStr.length) {
      if (aptDebugEnabled) {
        console.log('[APT DEBUG] _resolveTranslation trivial-merge no withMatchStr', {
          matchStr,
          onTradeStats: onTradeStats.map(aptDebugStatSummary),
        })
      }
      return undefined
    }
    if (aptDebugEnabled) {
      console.log('[APT DEBUG] _resolveTranslation trivial-merge candidates', {
        matchStr,
        withMatchStr: withMatchStr.map(aptDebugStatSummary),
      })
    }
    const merged = withMatchStr[0]
    for (const stat of withMatchStr) {
      if (merged === stat) continue
      _mergeTradeIdsInto(merged, stat)
    }
    return merged
  } else if (resolve.strat === 'percent-merge') {
    const pctStat = stats[resolve.kind.indexOf('percent')]
    const matcher = pctStat.matchers.find(m =>
      m.string === matchStr || m.advanced === matchStr)
    const roll100 = (matcher !== undefined && matcher.value === 100)
    if (roll100) {
      const otherStat = stats[resolve.kind.indexOf('value')]
      const flag = (otherStat.matchers.length === 1 && !otherStat.matchers[0].string.includes('#'))
      _mergeTradeIdsInto(pctStat, otherStat, flag ? '{empty_if_100}' : '{div_by_100}')
      return pctStat
    }
    return stats.find(stat =>
      stat.matchers.some(m => m.string === matchStr || m.advanced === matchStr))
  } else if (resolve.strat === 'flag-merge') {
    if (roll === undefined) return undefined
    const valStat = stats[resolve.kind.indexOf('value')]
    const flagStat = stats[resolve.kind.indexOf('flag')]
    const flagRoll = flagStat.matchers[0].value!
    if (roll === flagRoll) {
      _mergeTradeIdsInto(valStat, flagStat, '{empty}')
    }
    return valStat
  }
  return undefined
}

function _mergeTradeIdsInto (dest: Stat, source: Stat, prefix?: string) {
  for (const modType in source.trade.ids) {
    let tradeId = source.trade.ids[modType][0]
    if (prefix) tradeId = prefix + tradeId
    if (modType in dest.trade.ids) {
      if (!dest.trade.ids[modType].includes(tradeId)) {
        dest.trade.ids[modType].push(tradeId)
      }
    } else {
      dest.trade.ids[modType] = [tradeId]
    }
  }
}

function testItemCategory (actual: ItemCategory | null, expected: string): boolean {
  if (actual === null) return false

  switch (expected) {
    case 'WEAPON':
      return WEAPON.has(actual)
    case 'ARMOUR':
      return ARMOUR.has(actual)
    case 'HEIST_EQUIPMENT':
      return HEIST_EQUIPMENT.has(actual)
    default:
      return expected === actual
  }
}

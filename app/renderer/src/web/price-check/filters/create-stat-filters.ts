import { ParsedItem, ItemRarity, ItemCategory } from '@/parser'
import { ModifierType, StatCalculated, statSourcesTotal, translateStatWithRoll } from '@/parser/modifiers'
import { percentRoll, percentRollDelta, roundRoll } from './util'
import { FilterTag, ItemHasEmptyModifier, StatFilter, hasAnyFilterTag, hasFilterTag } from './interfaces'
import { filterPseudo, PSEUDO_SOURCE_STATS } from './pseudo'
import { applyRules as applyAtzoatlRules } from './pseudo/atzoatl-rules'
import { applyRules as applyMirroredTabletRules } from './pseudo/reflection-rules'
import { filterItemProp, filterBasePercentile, filterMemoryStrands,PROPERTY_USED_STATS } from './pseudo/item-property'
import { mapProps, valdoBadMods } from './pseudo/maps'
import { applyFlaskHybridMod } from './pseudo/flasks'
import { applyHeistRules } from './pseudo/heist'
import { decodeOils, applyAnointmentRules } from './pseudo/anointments'
import { StatBetter, CLIENT_STRINGS } from '@/assets/data'


export interface FiltersCreationContext {
  readonly item: ParsedItem
  readonly searchInRange: number
  filters: StatFilter[]
  statsByType: StatCalculated[]
}

export function createExactStatFilters (
  item: ParsedItem,
  statsByType: StatCalculated[],
  opts: { searchStatRange: number }
): StatFilter[] {
  if (
    item.mapBlighted ||
    item.category === ItemCategory.Invitation
  ) return []
  if (
    item.isUnidentified &&
    item.rarity === ItemRarity.Unique &&
    !item.isSynthesised
  ) return []

  const keepByType = [ModifierType.Pseudo, ModifierType.Fractured, ModifierType.Enchant, ModifierType.Necropolis, ModifierType.Imbued]

  if (
    !item.influences.length &&
    !item.isFractured &&
    item.category !== ItemCategory.Tincture &&
    item.category !== ItemCategory.Idol
  ) {
    keepByType.push(ModifierType.Implicit)
  }

  if (item.rarity === ItemRarity.Magic && (
    item.category !== ItemCategory.ClusterJewel &&
    item.category !== ItemCategory.Map &&
    item.category !== ItemCategory.HeistContract &&
    item.category !== ItemCategory.HeistBlueprint &&
    item.category !== ItemCategory.Sentinel
  )) {
    keepByType.push(ModifierType.Explicit)
  } else if (item.rarity === ItemRarity.Rare && item.category === ItemCategory.Idol) {
    keepByType.push(ModifierType.Explicit)
  }

  if (item.category === ItemCategory.Flask) {
    keepByType.push(ModifierType.Crafted)
  }

  const ctx: FiltersCreationContext = {
    item,
    searchInRange: (item.category !== ItemCategory.Map)
      ? Math.min(2, opts.searchStatRange)
      : opts.searchStatRange,
    filters: [],
    statsByType: statsByType.filter(calc => keepByType.includes(calc.type))
  }

  filterBasePercentile(ctx)
  filterMemoryStrands(ctx)
  mapProps(ctx)
  valdoBadMods(ctx)

  ctx.filters.push(
    ...ctx.statsByType.map(mod => calculatedStatToFilter(mod, ctx.searchInRange, item))
  )

  if (item.info.refName === 'Chronicle of Atzoatl') {
    applyAtzoatlRules(ctx.filters)
    return ctx.filters
  }
  if (item.info.refName === 'Mirrored Tablet') {
    applyMirroredTabletRules(ctx.filters)
    return ctx.filters
  }
  if (item.category === ItemCategory.Map) {
    for (const filter of ctx.filters) {
      if (!hasFilterTag(filter, FilterTag.Property) && !hasFilterTag(filter, FilterTag.Pseudo)) {
        filter.disabled = false
      }
    }
    return ctx.filters
  }

  for (const filter of ctx.filters) {
    filter.hidden = undefined

    if (hasFilterTag(filter, FilterTag.Explicit)) {
      filter.disabled = !filter.sources.some(source =>
        source.modifier.info.tier != null &&
        source.modifier.info.tier <= 2
      )
    } else if (!hasFilterTag(filter, FilterTag.Property)) {
      filter.disabled = false
    }

//    if (
//      hasFilterTag(filter, FilterTag.Explicit) &&
//      filter.sources.some(source => PSEUDO_SOURCE_STATS.has(source.stat.stat.ref))
//    ) {
//      filter.hidden = 'filters.hide_pseudo_source'
//      filter.disabled = true
//    }

    if (filter.statRef === '# uses remaining') {
      filter.roll!.min = filter.roll!.value
      filter.roll!.default.min = filter.roll!.value
      filter.roll!.default.max = filter.roll!.value
    }
  }

  hideSourceFilters(ctx)

  if (item.category === ItemCategory.ClusterJewel) {
    applyClusterJewelRules(ctx.filters)
  } if (
    item.category === ItemCategory.HeistContract ||
    item.category === ItemCategory.HeistBlueprint
  ) {
    applyHeistRules(ctx)
  } else if (item.category === ItemCategory.Flask) {
    applyFlaskRules(ctx.filters)
    applyFlaskHybridMod(ctx)
  } else if (
    item.category === ItemCategory.MemoryLine ||
    item.category === ItemCategory.SanctumRelic ||
    item.category === ItemCategory.Charm
  ) {
    enableAllFilters(ctx.filters)
  } else if (item.category === ItemCategory.Idol) {
    enableGoodRolledFilters(ctx.filters, 0.66)
  }

  return ctx.filters
}

function hideSourceFilters (ctx: FiltersCreationContext) {
  for (const filter of ctx.filters) {
    const isPseudoSourceStat = PSEUDO_SOURCE_STATS.has(filter.statRef)
    const isPropertyUsedStat = PROPERTY_USED_STATS.has(filter.statRef)

    const shouldHidePseudoSource =
      isPseudoSourceStat &&
      (
        hasFilterTag(filter, FilterTag.Explicit) ||
        hasFilterTag(filter, FilterTag.Implicit)
      )

    const shouldHidePropertyUsedSource =
      isPropertyUsedStat &&
      hasFilterTag(filter, FilterTag.Explicit)

    if (shouldHidePseudoSource || shouldHidePropertyUsedSource) {
      filter.hidden = 'filters.hide_pseudo_source'
      filter.disabled = true
    }
  }
}

export function initUiModFilters (
  item: ParsedItem,
  opts: {
    searchStatRange: number
  }
): StatFilter[] {
  const ctx: FiltersCreationContext = {
    item,
    filters: [],
    searchInRange: (item.rarity === ItemRarity.Normal) ? 100 : opts.searchStatRange,
    statsByType: item.statsByType
  }

  if (item.info.refName !== 'Split Personality') {
    filterItemProp(ctx)
    filterPseudo(ctx)
    if (item.info.refName === "Emperor's Vigilance") {
      filterBasePercentile(ctx)
    }
    filterMemoryStrands(ctx, 'hide_memory_strands')
  }

  if (item.isVeiled) {
    ctx.statsByType = ctx.statsByType.filter(mod => mod.type !== ModifierType.Veiled)
  }

  //ctx.statsByType = mergeSameStatByType(ctx.statsByType)

  ctx.filters.push(
    ...ctx.statsByType.map(mod => calculatedStatToFilter(mod, ctx.searchInRange, item))
  )

  if (item.isVeiled) {
    ctx.filters.forEach(filter => { filter.disabled = true })
  }

  hideSourceFilters(ctx)

  finalFilterTweaks(ctx)

  return ctx.filters
}

function pickTradeIdsByModifierType (
  tradeIds: Partial<Record<ModifierType, string[]>>,
  type: ModifierType
): string[] {
  switch (type) {
    case ModifierType.Implicit:
      return tradeIds[ModifierType.Implicit]
        ?? tradeIds[ModifierType.Explicit]
        ?? []

    case ModifierType.Fractured:
      return tradeIds[ModifierType.Fractured]
        ?? tradeIds[ModifierType.Explicit]
        ?? []

    case ModifierType.Crafted:
      return tradeIds[ModifierType.Crafted]
        ?? tradeIds[ModifierType.Explicit]
        ?? []

    case ModifierType.Enchant:
      return tradeIds[ModifierType.Enchant]
        ?? tradeIds[ModifierType.Implicit]
        ?? tradeIds[ModifierType.Explicit]
        ?? []

    case ModifierType.Scourge:
      return tradeIds[ModifierType.Scourge]
        ?? tradeIds[ModifierType.Implicit]
        ?? tradeIds[ModifierType.Explicit]
        ?? []

    default:
      return tradeIds[type]
        ?? tradeIds[ModifierType.Explicit]
        ?? tradeIds[ModifierType.Implicit]
        ?? tradeIds[ModifierType.Fractured]
        ?? []
  }
}

function filterTagsForModifierType (type: ModifierType): FilterTag[] {
  switch (type) {
    case ModifierType.Pseudo:
      return [FilterTag.Pseudo]
    case ModifierType.Explicit:
      return [FilterTag.Explicit]
    case ModifierType.Implicit:
      return [FilterTag.Implicit]
    case ModifierType.Crafted:
      return [FilterTag.Explicit, FilterTag.Crafted]
    case ModifierType.Fractured:
      return [FilterTag.Explicit, FilterTag.Fractured]
    case ModifierType.Enchant:
      return [FilterTag.Enchant]
    case ModifierType.Scourge:
      return [FilterTag.Scourge]
    default:
      return [(type as unknown) as FilterTag]
  }
}

function uniqueFilterTags (tags: FilterTag[]): FilterTag[] {
  return [...new Set(tags)]
}

function setFilterTags (filter: StatFilter, tags: FilterTag[]) {
  filter.tags = uniqueFilterTags(tags)
}

export function calculatedStatToFilter (
  calc: StatCalculated,
  percent: number,
  item: ParsedItem
): StatFilter {
  const { stat, sources, type } = calc
  let filter: StatFilter

  console.log(
    '[APT CALC DEBUG]',
    {
      statRef: stat.ref,
      type: type,
      tradeIds: stat.trade.ids,
      sourceText: sources?.map(s =>
        s.stat.translation.string
      )
    }
  )

  if (stat.trade.option) {
    filter = {
      tradeId: pickTradeIdsByModifierType(
        stat.trade.ids,
        type
      ),
      statRef: stat.ref,
      text: sources[0].stat.translation.string,
      tags: (type === ModifierType.Enchant)
        ? [FilterTag.Enchant]
        : [FilterTag.Variant],
      oils: decodeOils(calc),
      sources: sources,
      option: {
        value: sources[0].contributes!.value
      },
      disabled: false
    }
    
    if (filter.oils) {
      filter.disabled = true
    }
  }

  const roll = statSourcesTotal(
    calc.sources,
    (item.info.refName === 'Mirrored Tablet') ? 'max' : 'sum'
  )
  const translation = translateStatWithRoll(calc, roll)

  const debugTradeIds =
    pickTradeIdsByModifierType(
      stat.trade.ids,
      type
    )

  filter ??= {
    tradeId: pickTradeIdsByModifierType(
      stat.trade.ids,
      type
    ),
    /*
    tradeId: pickTradeIdsByModifierType(
      stat.trade.ids,
      type
    ),
    */
    statRef: stat.ref,
    text: translation.string,
    tags: filterTagsForModifierType(type),
    oils: decodeOils(calc),
    sources: sources,
    roll: undefined,
    disabled: true
  }

  if (type === ModifierType.Implicit) {
    if (sources.some(s => s.modifier.info.generation === 'corrupted')) {
      setFilterTags(filter, [FilterTag.Implicit, FilterTag.Corrupted])
    } else if (sources.some(s => s.modifier.info.generation === 'eldritch')) {
      setFilterTags(filter, [FilterTag.Implicit, FilterTag.Eldritch])
    } else if (item.isSynthesised) {
      setFilterTags(filter, [FilterTag.Implicit, FilterTag.Synthesised])
    }
  } else if (type === ModifierType.Explicit) {
    if (sources.some(s => s.modifier.info.generation === 'foulborn')) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Foulborn])
    } else if (item.info.unique?.fixedStats) {
      const fixedStats = item.info.unique.fixedStats
      if (!fixedStats.includes(filter.statRef)) {
        setFilterTags(filter, [FilterTag.Explicit, FilterTag.Variant])
      }
    } else if (sources.some(s => CLIENT_STRINGS.SHAPER_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Shaper])
    } else if (sources.some(s => CLIENT_STRINGS.ELDER_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Elder])
    } else if (sources.some(s => CLIENT_STRINGS.HUNTER_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Hunter])
    } else if (sources.some(s => CLIENT_STRINGS.WARLORD_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Warlord])
    } else if (sources.some(s => CLIENT_STRINGS.REDEEMER_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Redeemer])
    } else if (sources.some(s => CLIENT_STRINGS.CRUSADER_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Crusader])
    } else if (sources.some(s => CLIENT_STRINGS.DELVE_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Delve])
    } else if (sources.some(s => CLIENT_STRINGS.VEILED_MODS.includes(s.modifier.info.name!))) {
      // can't drop from ground, so don't show
      // setFilterTags(filter, [FilterTag.Explicit, FilterTag.Unveiled])
    } else if (sources.some(s => CLIENT_STRINGS.INCURSION_MODS.includes(s.modifier.info.name!))) {
      setFilterTags(filter, [FilterTag.Explicit, FilterTag.Incursion])
    }
  }

  if (roll && !filter.option) {
    if (item.rarity === ItemRarity.Magic && (
      item.isUnmodifiable || item.isCorrupted || item.isMirrored
    )) {
      percent = 0
    } else if (
      item.rarity === ItemRarity.Unique ||
      (item.rarity === ItemRarity.Magic && item.category === ItemCategory.Jewel) ||
      calc.sources.some(({ modifier }) => modifier.info.tier === 1 && modifier.info.type === ModifierType.Fractured)
    ) {
      const perfectRoll = (
        (calc.stat.better === StatBetter.PositiveRoll && roll.value >= roll.max) ||
        (calc.stat.better === StatBetter.NegativeRoll && roll.value <= roll.min)
      )
      if (perfectRoll) {
        percent = 0
      }
    }

    let goodness: number | undefined
    if (calc.stat.better !== StatBetter.NotComparable) {
      if (roll.min === roll.max) {
        goodness = 1
      } else {
        goodness = (roll.value - roll.min) / (roll.max - roll.min)
        if (calc.stat.better === StatBetter.NegativeRoll) {
          goodness = 1 - goodness
        }
      }
    }

    const dp =
    calc.stat.dp ||
    calc.sources.some(s => s.stat.stat.ref === calc.stat.ref && s.stat.roll!.dp)

    const filterBounds = {
      min: percentRoll(roll.min, -0, Math.floor, dp),
      max: percentRoll(roll.max, +0, Math.ceil, dp)
    }

    const filterDefault = (calc.stat.better === StatBetter.NotComparable)
      ? { min: roll.value, max: roll.value }
      : (item.rarity === ItemRarity.Unique)
          ? {
              min: percentRollDelta(roll.value, (roll.max - roll.min), -percent, Math.floor, dp),
              max: percentRollDelta(roll.value, (roll.max - roll.min), +percent, Math.ceil, dp)
            }
          : {
              min: percentRoll(roll.value, -percent, Math.floor, dp),
              max: percentRoll(roll.value, +percent, Math.ceil, dp)
            }
    filterDefault.min = Math.max(filterDefault.min, filterBounds.min)
    filterDefault.max = Math.min(filterDefault.max, filterBounds.max)

    filter.roll = {
      value: roundRoll(roll.value, dp),
      min: undefined,
      max: undefined,
      default: filterDefault,
      bounds: (item.rarity === ItemRarity.Unique && roll.min !== roll.max && calc.stat.better !== StatBetter.NotComparable)
        ? filterBounds
        : undefined,
      dp: dp,
      isNegated: false,
      tradeInvert: calc.stat.trade.inverted,
      goodness
    }

    filterFillMinMax(filter.roll, calc.stat.better)

    if (translation.negate) {
      filterAdjustmentForNegate(filter.roll)
    }
  }

  hideNotVariableStat(filter, item)

  console.log('[APT DEBUG] calculatedStatToFilter', {
    statRef: stat.ref,
    text: stat.matchers?.[0]?.string,
    type,
    originalTradeIds: stat.trade?.ids,
    selectedTradeIds: debugTradeIds
  })
  return filter
}

function hideNotVariableStat (filter: StatFilter, item: ParsedItem) {
  if (item.rarity !== ItemRarity.Unique) return
  if (hasFilterTag(filter, FilterTag.Implicit) &&
    item.category === ItemCategory.Jewel) return
  if (!hasAnyFilterTag(filter, [FilterTag.Implicit, FilterTag.Explicit, FilterTag.Pseudo])) return

  if (!filter.roll) {
    filter.hidden = 'filters.hide_const_roll'
  } else if (!filter.roll.bounds) {
    filter.roll.min = undefined
    filter.roll.max = undefined
    filter.hidden = 'filters.hide_const_roll'
  }

  if (item.isFoulborn && hasFilterTag(filter, FilterTag.Explicit)) {
    // some mod not being replaced with foulborn one can be important
    filter.hidden = undefined
    filter.disabled = false
  }
}

function filterFillMinMax (
  roll: NonNullable<StatFilter['roll']>,
  better: StatBetter
) {
  switch (better) {
    case StatBetter.PositiveRoll:
      roll.min = roll.default.min
      break
    case StatBetter.NegativeRoll:
      roll.max = roll.default.max
      break
    case StatBetter.NotComparable:
      roll.min = roll.default.min
      roll.max = roll.default.max
      break
  }
}

function filterAdjustmentForNegate (
  roll: NonNullable<StatFilter['roll']>
) {
  roll.tradeInvert = !roll.tradeInvert
  roll.isNegated = true
  const swap = JSON.parse(JSON.stringify(roll)) as typeof roll

  if (swap.bounds && roll.bounds) {
    roll.bounds.min = -1 * swap.bounds.max
    roll.bounds.max = -1 * swap.bounds.min
  }

  roll.default.min = -1 * swap.default.max
  roll.default.max = -1 * swap.default.min

  roll.value = -1 * swap.value
  roll.min = (typeof swap.max === 'number')
    ? -1 * swap.max
    : undefined
  roll.max = (typeof swap.min === 'number')
    ? -1 * swap.min
    : undefined
}

function finalFilterTweaks (ctx: FiltersCreationContext) {
  const { item } = ctx

  if (item.category === ItemCategory.ClusterJewel && item.rarity !== ItemRarity.Unique) {
    applyClusterJewelRules(ctx.filters)
  } else if (item.category === ItemCategory.Flask) {
    applyFlaskRules(ctx.filters)
    applyFlaskHybridMod(ctx)
  }

  const hasEmptyModifier = showHasEmptyModifier(ctx)
  if (hasEmptyModifier !== false) {
    ctx.filters.push({
      tradeId: ['item.has_empty_modifier'],
      text: '1 Empty or Crafted Modifier',
      statRef: '1 Empty or Crafted Modifier',
      disabled: true,
      hidden: 'filters.hide_empty_mod',
      tags: [FilterTag.Pseudo],
      sources: [],
      option: {
        value: hasEmptyModifier
      }
    })
  }

  if (item.category === ItemCategory.Amulet || item.category === ItemCategory.Ring) {
    applyAnointmentRules(ctx.filters, ctx.item)
  }

  for (const filter of ctx.filters) {
    if (hasFilterTag(filter, FilterTag.Fractured)) {
      const mod = ctx.item.statsByType.find(mod => mod.stat.ref === filter.statRef)!
      if (mod.stat.trade.ids[ModifierType.Explicit]) {
        // hide only if fractured mod has corresponding explicit variant
        filter.hidden = 'filters.hide_for_crafting'
      }
    } else if (hasFilterTag(filter, FilterTag.Foulborn) || hasFilterTag(filter, FilterTag.Variant)) {
      filter.disabled = false
    }
  }

  if (item.rarity === ItemRarity.Unique) {
    const countVisible = ctx.filters.reduce((cnt, filter) => filter.hidden ? cnt : cnt + 1, 0)
    if (countVisible <= 3) {
      enableAllFilters(ctx.filters)
    }
  }
}

function applyClusterJewelRules (filters: StatFilter[]) {
  for (const filter of filters) {
    if (filter.statRef === '# Added Passive Skills are Jewel Sockets') {
      filter.hidden = 'filters.hide_const_roll'
      filter.disabled = true
    }

    // https://www.poewiki.net/wiki/Cluster_Jewel#Optimal_passive_skill_amounts
    if (filter.statRef === 'Adds # Passive Skills') {
      filter.disabled = false

      // 4 is [_, 5]
      if (filter.roll!.value === 4) {
        filter.roll!.max = 5
      // 5 is [5, 5]
      } else if (filter.roll!.value === 5) {
        filter.roll!.min = filter.roll!.default.min
      // 3, 6, 10, 11, 12 are [n, _]
      } else if (
        filter.roll!.value === 3 ||
        filter.roll!.value === 6 ||
        filter.roll!.value === 10 ||
        filter.roll!.value === 11 ||
        filter.roll!.value === 12
      ) {
        filter.roll!.min = filter.roll!.default.min
        filter.roll!.max = undefined
      }
      // else 2, 8, 9 are [_ , n]
    }
  }
}

function applyFlaskRules (filters: StatFilter[]) {
  const usedEnkindling = filters.find(filter => filter.statRef === 'Gains no Charges during Flask Effect')
  for (const filter of filters) {
    if (hasFilterTag(filter, FilterTag.Enchant) && !usedEnkindling) {
      filter.hidden = 'hide_harvest_and_instilling'
      filter.disabled = true
    }
  }
}

// TODO
// +1 Prefix Modifier allowed
// -1 Suffix Modifier allowed
function showHasEmptyModifier (ctx: FiltersCreationContext): ItemHasEmptyModifier | false {
  const { item } = ctx

  if (
    item.rarity !== ItemRarity.Rare ||
    item.isCorrupted ||
    item.isMirrored
  ) return false

  const randomMods = item.newMods.filter(mod =>
    mod.info.type === ModifierType.Explicit ||
    mod.info.type === ModifierType.Fractured ||
    mod.info.type === ModifierType.Veiled ||
    mod.info.type === ModifierType.Crafted)

  const craftedMod = randomMods.find(mod => mod.info.type === ModifierType.Crafted)

  if (
    (randomMods.length === 5 && !craftedMod) ||
    (randomMods.length === 6 && craftedMod)
  ) {
    let prefixes = randomMods.filter(mod => mod.info.generation === 'prefix').length
    let suffixes = randomMods.filter(mod => mod.info.generation === 'suffix').length

    if (craftedMod) {
      if (craftedMod.info.generation === 'prefix') {
        prefixes -= 1
      } else {
        suffixes -= 1
      }
    }

    if (prefixes === 2) return ItemHasEmptyModifier.Prefix
    if (suffixes === 2) return ItemHasEmptyModifier.Suffix
  }

  return false
}

function enableAllFilters (filters: StatFilter[]) {
  for (const filter of filters) {
    if (!filter.hidden) {
      filter.disabled = false
    }
  }
}

function enableGoodRolledFilters (filters: StatFilter[], abovePct: number) {
  for (const filter of filters) {
    if (filter.hidden) continue
    if (!filter.roll || filter.roll.goodness == null) {
      filter.disabled = false
      continue
    }

    if (filter.roll.goodness >= abovePct) {
      filter.disabled = false
    }
  }
}

function mergeSameStatByType (stats: StatCalculated[]): StatCalculated[] {
  const merged: StatCalculated[] = []

for (const stat of stats) {
  const keyType = (
    stat.type === ModifierType.Fractured &&
    stat.stat.trade.ids[ModifierType.Explicit]
  )
    ? ModifierType.Explicit
    : stat.type

  const found = merged.find(item =>
    item.type === stat.type &&
    item.stat.ref === stat.stat.ref &&
    item.sources.some(s => s.modifier.info.type === ModifierType.Fractured) ===
    stat.sources.some(s => s.modifier.info.type === ModifierType.Fractured)
  )

  if (found) {
    found.sources.push(...stat.sources)
  } else {
    merged.push({
      ...stat,
      type: keyType,
      sources: [...stat.sources]
    })
  }
}

  return merged
}
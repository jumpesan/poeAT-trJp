<template>
  <span>
    <template v-for="(part, idx) of parts" :key="idx">
      <span>{{ part }}</span>
      <span v-if="idx < parts.length - 1">{{ displayRoll }}</span>
    </template>
  </span>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue'

export default defineComponent({
  props: {
    text: {
      type: String,
      required: true
    },
    roll: {
      type: Number,
      required: false
    },
    showPlus: {
      type: Boolean,
      required: false,
      default: false
    }
  },
  setup (props) {
    const displayText = computed(() => {
      if (props.roll == null || props.roll >= 0) {
        return props.text
      }

      return props.text
        .replace('増加する', '低下する')
        .replace('増加', '減少')
    })

    const parts = computed(() => displayText.value.split('#'))

    const displayRoll = computed(() => {
      if (props.roll == null) {
        return '#'
      }

      const absRoll = Math.abs(props.roll)

      const textAlreadyHasPlus =
        props.text.includes('+#') ||
        props.text.includes('+ #') ||
        props.text.includes(' +')

      if (
        props.showPlus &&
        absRoll > 0 &&
        !textAlreadyHasPlus
      ) {
        return `+${absRoll}`
      }

      return String(absRoll)
    })

    return {
      parts,
      displayRoll
    }
  }
})
</script>
<template>
  <widget
    :config="config"
    move-handles="center"
    v-slot="{ isMoving }"
    :readonly="true"
    :removable="false"
    :hideable="true">
    <div :class="$style.wrapper">
      <div :class="$style.label">{{ t('map_timer.name') }}</div>
      <div :class="$style.timer">
        <span>{{ formatted.m }}:{{ formatted.s }}:</span><span>{{ formatted.ms }}</span>
      </div>
      <div v-if="!isRunning" :class="$style.paused">{{ t('map_timer.paused') }}</div>
      <div v-if="!isMoving" :class="$style.controls">
        <button v-if="!isRunning" @click="start" :class="$style.button"><i class="fas fa-play"></i></button>
        <button v-else @click="stop" :class="$style.button"><i class="fas fa-pause"></i></button>
        <button @click="reset" :class="$style.button"><i class="fas fa-redo"></i></button>
      </div>
    </div>
  </widget>
</template>

<script lang="ts">
import { defineComponent, PropType, inject, ref, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Widget from '../overlay/Widget.vue'
import { MainProcess } from '@/web/background/IPC'
import { WidgetManager, MapRunTimerWidget, WidgetSpec } from '../overlay/interfaces'
import { AppConfig } from '@/web/Config'

export default defineComponent({
  widget: {
    type: 'map-run-timer',
    instances: 'single',
    trNameKey: 'map_timer.name',
    initInstance: (): MapRunTimerWidget => {
      return {
        wmId: 0,
        wmType: 'map-run-timer',
        wmTitle: '{icon=fa-stopwatch}',
        wmWants: 'hide',
        wmZorder: null,
        wmFlags: ['invisible-on-blur'],
        anchor: {
          pos: 'cc',
          x: 50,
          y: 18
        }
      }
    }
  } satisfies WidgetSpec,
  components: { Widget },
  props: {
    config: {
      type: Object as PropType<MapRunTimerWidget>,
      required: true
    }
  },
  setup (props) {
    const wm = inject<WidgetManager>('wm')!

    if (props.config.wmFlags[0] === 'uninitialized') {
      props.config.anchor = {
        pos: 'cc',
        x: 50,
        y: 18
      }
      wm.show(props.config.wmId)
    }
    props.config.wmFlags = ['invisible-on-blur']

    const isRunning = ref(false)
    const millis = ref(0)
    const frozenMillis = ref(0)
    const isFrozen = ref(false)
    const prevTick = ref(0)

    const timerId = setInterval(updateTime, 50)
    onUnmounted(() => {
      clearInterval(timerId)
    })

    const mapRunTimerActionController = MainProcess.onEvent('MAIN->CLIENT::widget-action', (e) => {
      if (e.target === 'map-run-timer-reset-start') {
        isFrozen.value = false
        wm.show(props.config.wmId)
        reset()
        start()
        return
      }

      if (e.target === 'map-run-timer-freeze') {
        freezeDisplay()
        wm.show(props.config.wmId)
        return
      }

      if (e.target === 'map-run-timer-hide') {
        wm.hide(props.config.wmId)
        return
      }

      if (e.target === 'map-run-timer-show') {
        isFrozen.value = false
        wm.show(props.config.wmId)
      }
    })
    onUnmounted(() => {
      mapRunTimerActionController.abort()
    })

    const formatted = computed(() => {
      const sourceMillis = isFrozen.value ? frozenMillis.value : millis.value
      const totalMillis = Math.max(0, Math.floor(sourceMillis))
      const minutes = Math.floor(totalMillis / 60000)
      const seconds = Math.floor((totalMillis % 60000) / 1000)
      const milliseconds = totalMillis % 1000

      return {
        m: String(minutes).padStart(2, '0'),
        s: String(seconds).padStart(2, '0'),
        ms: String(milliseconds).padStart(3, '0')
      }
    })

    function ensureClientLogConfigured (): boolean {
      if (AppConfig().clientLog) return true
      window.alert(t('map_timer.client_log_required'))
      return false
    }

    function start () {
      if (!ensureClientLogConfigured()) return

      isFrozen.value = false
      isRunning.value = true
      prevTick.value = Date.now()
      wm.setFlag(props.config.wmId, 'invisible-on-blur', false)
    }

    function stop () {
      updateTime()
      isRunning.value = false
      if (millis.value < 1000) {
        wm.setFlag(props.config.wmId, 'invisible-on-blur', true)
      }
    }

    function reset () {
      isFrozen.value = false
      prevTick.value = Date.now()
      millis.value = 0
      if (!isRunning.value) {
        wm.setFlag(props.config.wmId, 'invisible-on-blur', true)
      }
    }

    function freezeDisplay () {
      if (isFrozen.value) {
        return
      }

      updateTime()
      frozenMillis.value = millis.value
      isFrozen.value = true
    }

    function updateTime () {
      if (isRunning.value) {
        const now = Date.now()
        millis.value += now - prevTick.value
        prevTick.value = now
      }
    }

    const { t } = useI18n()

    return {
      t,
      formatted,
      isRunning,
      start,
      stop,
      reset
    }
  }
})
</script>

<style lang="postcss" module>
.timer {
  font-size: 2rem;
  line-height: 1;
  @apply font-mono;
  text-shadow: 0 1px 3px rgb(0, 0, 0);
}

.label {
  line-height: 1;
  @apply text-xs text-gray-200 text-center mb-1;
  text-shadow: 0 1px 3px rgb(0, 0, 0);
}

.button {
  background: rgba(29, 29, 29, 0.863);
  @apply rounded;
  line-height: 1;
  width: 2rem;
  height: 2rem;
  @apply mx-1;
}

.controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.wrapper {
  @apply px-2 py-1;
  @apply rounded text-white;
  @apply bg-gray-300/30;

  &:not(:hover) {
    .controls {
      display: none;
    }
  }
}

.paused {
  position: absolute;
  top: 0;
  right: 0;
  line-height: 1;
  @apply px-2 rounded shadow;
  @apply bg-orange-700 text-white;
}
</style>

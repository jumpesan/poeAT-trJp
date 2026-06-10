<template>

<div class="settings-page">

<h2>アイテム保存</h2>

<button
@click="refreshCharacters"
>

キャラクターリスト更新

</button>


<select
v-model="selectedCharacterKey"
>

<option
v-for="c in characters"
:key="`${c.name}:${c.league}`"
:value="`${c.name}:${c.league}`"
>

{{c.name}}
({{c.league}})

</option>

</select>


<button
@click="confirmCharacter"
>

決定

</button>


<div>

現在の対象:

{{currentCharacter}}

</div>

</div>

</template>

<script setup lang="ts">

import { ref } from 'vue'

type PoeCharacter = {
  name: string
  league: string
}

const characters = ref<PoeCharacter[]>([])

const selectedCharacterKey=ref('')

const currentCharacter=ref('未選択')

async function refreshCharacters() {
  characters.value =
    await window.electron
      .ipcRenderer
      .invoke('poe-get-characters') as PoeCharacter[]
}

function confirmCharacter(){

    currentCharacter.value=
        selectedCharacterKey.value

}

</script>
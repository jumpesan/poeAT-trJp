<template>
<div class="settings-page">

<h2>PoEログイン</h2>

<button @click="login">

PoEログイン

</button>

</div>
</template>

<script setup lang="ts">

async function login(){

    await window.electron.ipcRenderer.invoke(
        'poe-login-open'
    )

}

</script>
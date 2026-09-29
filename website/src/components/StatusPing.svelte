<script lang="ts">
  let checked = $state(false);
</script>

<button onclick={() => (checked = !checked)}>
  {checked ? "Parousia is present." : "Check presence"}
</button>

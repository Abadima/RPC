<script lang="ts">
  let checked = $state(false);
</script>

<button onclick={() => (checked = !checked)}>
  {checked ? "PAROUSIA is present." : "Check presence"}
</button>

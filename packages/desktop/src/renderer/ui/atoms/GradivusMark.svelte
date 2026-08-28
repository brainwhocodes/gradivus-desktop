<script lang="ts">
  import gradivusLogoUrl from "../../../../resources/titlebar-logo.png?url";
  export let size = 28;
</script>

<img
  class="gradivus-mark"
  src={gradivusLogoUrl}
  alt="Gradivus mark"
  width={size}
  height={size}
  style={`width: ${size}px; height: ${size}px; border-radius: 4px; object-fit: cover; flex-shrink: 0; display: inline-block; vertical-align: middle;`}
/>

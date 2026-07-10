<svelte:head>
  <title>pi-squared admin</title>
  <meta name="description" content="Administration console for the pi-squared distributed coding agent." />
</svelte:head>

<main>
  <header>
    <p class="eyebrow">pi-squared</p>
    <h1>Admin console</h1>
    <p class="introduction">
      Manage the distributed coding agent from this console. Executor, client, and session controls will appear here as
      they become available.
    </p>
  </header>

  <section aria-labelledby="ui-heading">
    <div>
      <p class="label">Admin UI</p>
      <h2 id="ui-heading">Ready for connections</h2>
    </div>
    <span class="status"><span aria-hidden="true"></span>Online</span>
  </section>

  <footer>Server connectivity is configured independently from this interface.</footer>
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(html) {
    color-scheme: dark;
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    background: #090d14;
    color: #e7edf7;
  }

  :global(body) {
    min-width: 20rem;
    min-height: 100vh;
    margin: 0;
    background:
      radial-gradient(circle at 15% 10%, rgb(67 97 238 / 18%), transparent 32rem),
      linear-gradient(145deg, #090d14 35%, #101827);
  }

  main {
    width: min(54rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: clamp(4rem, 12vh, 8rem) 0 3rem;
  }

  header {
    max-width: 44rem;
  }

  .eyebrow,
  .label {
    margin: 0 0 0.75rem;
    color: #8fa8ff;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.75rem, 9vw, 5.5rem);
    font-weight: 650;
    letter-spacing: -0.055em;
    line-height: 0.95;
  }

  .introduction {
    margin: 2rem 0 0;
    color: #a8b4c7;
    font-size: clamp(1rem, 2.4vw, 1.25rem);
    line-height: 1.7;
  }

  section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    margin-top: 4rem;
    padding: 1.5rem;
    border: 1px solid #29344a;
    border-radius: 1rem;
    background: rgb(16 24 39 / 75%);
    box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 20%);
  }

  section .label {
    margin-bottom: 0.45rem;
    color: #77869e;
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    flex: 0 0 auto;
    color: #a8f0c6;
    font-size: 0.875rem;
    font-weight: 650;
  }

  .status span {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #42d77d;
    box-shadow: 0 0 1rem #42d77d;
  }

  footer {
    margin-top: 1.5rem;
    color: #77869e;
    font-size: 0.875rem;
  }

  @media (max-width: 34rem) {
    section {
      align-items: flex-start;
      flex-direction: column;
      gap: 1rem;
    }
  }
</style>

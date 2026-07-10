import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import Page from "../src/routes/+page.svelte";

describe("admin page", () => {
  it("renders the administration console", () => {
    const { body, head } = render(Page);

    expect(head).toContain("<title>pi-squared admin</title>");
    expect(body).toContain("Admin console");
    expect(body).toContain("Server connectivity is configured independently");
  });
});

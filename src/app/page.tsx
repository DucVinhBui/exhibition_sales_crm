// Phase 0 placeholder. The crm-ui agent replaces this with the search screen.
// It must keep returning a literal HTTP 200: verify.sh curls "/" without following
// redirects, so a redirect here breaks the reviewer's acceptance check.
export default function HomePage() {
  return (
    <main>
      <h1>Exhibition Sales CRM</h1>
      <p>Scaffolding is up. Search, exhibitors, enquiries and follow-ups land next.</p>
    </main>
  );
}

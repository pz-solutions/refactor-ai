{{imports}}

{{queries}}

export const Route = createFileRoute("{{id}}")({
  {{searchDeps}}
  loader: {{loader}},
  component: {{component}},
});

function {{component}}() {
  {{setup}}
  {{todos}}
  return (
    <HydratedContent>
      {{view}}
    </HydratedContent>
  );
}

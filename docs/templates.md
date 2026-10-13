# Read a Core template

A Core recipe says **which local changes to make**. Catalog supplies the recipe
and its pinned files. The host supplies local values, such as the command pointing
to an installed hook. Core prepares those effects for review, then applies the
approved review. The same recipe works in Vibe and Enterprise; Enterprise adds
the organization policy boundary.

Start with [the complete example](../examples/templates/core-recipe.json). It
registers one hook in a hypothetical client's settings, without running the hook.
The example is about the recipe format; it is not a native client adapter.

| Field | Meaning in this example |
| --- | --- |
| `inputs.guardCommand` | A required string the caller supplies for this machine. |
| `target` | The project file Core will edit. |
| `container` | The array holding the client's hook groups. |
| `groupId` | Stable ownership identity across updates and removal. |
| `group.literal` | The fixed shape of the group. The empty command is filled by the binding. |
| `groupBindings` | Put `guardCommand` into the existing `hooks[0].command` string. |
| `selector` | Find the group by that same resolved command, preserving its neighbors. |

For example, one caller may supply

```json
{ "guardCommand": "node \"C:/Example Home/hooks/guard.mjs\"" }
```

Another caller supplies its own path. Neither caller changes the recipe bytes or
needs a new Catalog release. Strings are copied as values; Core does not expand
shell syntax or interpolate arbitrary JSON.

Recipe **1.3.0** adds `groupBindings` and the input form of `selector`. Use an
execution-policy **1.3.0** to select it. Earlier schemas retain their original
meaning and reject the new fields. Existing file, configuration, text-block and
process operations continue to use their existing scalar input slots.

A binding can only replace an existing scalar of the same type. It cannot add
fields, replace an object, use a prototype key, overlap another binding, or make
the group exceed its bounds. The selector must resolve to a nonempty string in
the resulting group. Inputs remain subject to their declared bounds and, in
Enterprise, the organization's permissions.

During an input-bound command update, Core locates the old group through its
recorded ownership, verifies the old bytes, and replaces that group. An edited,
missing, ambiguous, colliding or shared group still requires reconciliation;
the new command never silently claims another user's hook. Managed removal
uses the recorded member and preserves neighboring settings.

Use `validateRecipe` to check the template without host effects. Test the selected
recipe through `prepare` and `apply` in a temporary home/project, and use
`checkFileState` for a read-only comparison. Configuring a hook does not establish
that a native client has trusted or executed it.

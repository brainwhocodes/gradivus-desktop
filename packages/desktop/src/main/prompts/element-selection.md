# Page Element Selection

{{#if instruction}}
{{instruction}}
{{else}}
Inspect and edit the selected web page element.
{{/if}}

- **Page URL**: {{url}}
{{#if agentType}}
- **Requested Agent Type**: {{agentType}}
{{/if}}
{{#if targetAgentName}}
- **Workspace Target Agent**: {{targetAgentName}} (`{{targetAgentId}}`)
{{/if}}
- **Target Selector**: `{{selector}}`
{{#if tagName}}
- **Element Tag**: `<{{tagName}}>`
{{/if}}
{{#if captureMode}}
- **Capture Mode**: {{captureMode}}
{{/if}}
{{#if summary}}
- **Summary**: {{summary}}
{{/if}}
{{#if text}}
- **Text Content**: "{{text}}"
{{/if}}
{{#if screenshotWidth}}
- **Screenshot Dimensions**: {{screenshotWidth}}×{{screenshotHeight}}px
{{/if}}
{{#if screenshotAttached}}
- **Screenshot Attachment**: Included
{{/if}}
{{#if domHtml}}

Element DOM snippet:
```html
{{{domHtml}}}
```
{{/if}}

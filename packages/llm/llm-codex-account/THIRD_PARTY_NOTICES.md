# Third-party notices

## DeepSeek Harness native model directory

`src/client/native/` adapts model-catalog editor code from DeepSeek Harness. The source files are:

- `packages/client/ui-settings-models/src/client/ModelListEditor.tsx`
- `packages/client/ui-settings-models/src/client/ModelRow.tsx`
- `packages/client/ui-settings-models/src/client/ModelInputTypes.tsx`
- `packages/client/ui-settings-models/src/client/EditorFooter.tsx`
- Model draft, capacity, and validation helpers extracted from `DeepSeekModelsEditor.tsx`
- Related path, schema-operation, locale, and CSS-module code

Source: https://github.com/deepseek-ai/deepseek-harness

The adaptation uses this package's settings and discovery operations, locale namespace, and host UI primitives. OAuth code is not copied; this package uses the installed pi-ai authorization implementation.

The upstream copyright and license follow:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interpolacionesInseguras } from './validar-workflow-inputs.mjs';

describe('guardrail de inputs en bloques run', () => {
  const inseguros = [
    'run: echo "${{ inputs.portal }}"',
    '"run": echo "${{ inputs[\'portal\'] }}"',
    "'run': echo \"${{ inputs[\"portal\"] }}\"",
    'run: echo "${{ github.event.inputs.portal }}"',
    'run: echo "${{ github.event.inputs[\'portal\'] }}"',
    ['run: |', '  echo "${{', '    inputs.portal', '  }}"'].join('\n'),
  ];

  for (const workflow of inseguros) {
    it(`rechaza ${JSON.stringify(workflow)}`, () => {
      assert.deepEqual(interpolacionesInseguras(workflow), ['workflow.yml:1']);
    });
  }

  it('acepta el input fuera del shell y la variable citada dentro de run', () => {
    const workflow = [
      'steps:',
      '  - env:',
      '      PORTAL: ${{ inputs.portal }}',
      '    run: printf \'%s\\n\' "$PORTAL"',
    ].join('\n');

    assert.deepEqual(interpolacionesInseguras(workflow), []);
  });

  it('reporta cada bloque inseguro por la linea donde comienza', () => {
    const workflow = [
      'steps:',
      '  - run: echo "${{ inputs.portal }}"',
      '  - name: segundo',
      '    "run": |',
      '      echo "${{ github.event.inputs.portal }}"',
    ].join('\n');

    assert.deepEqual(interpolacionesInseguras(workflow, 'ci.yml'), ['ci.yml:2', 'ci.yml:4']);
  });
});

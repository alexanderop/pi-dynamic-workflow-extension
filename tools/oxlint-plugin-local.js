const TEST_CASE_FUNCTIONS = new Set(["it", "test"]);
const TEST_CASE_MODIFIERS = new Set(["only", "skip"]);

function getStaticPropertyName(node) {
  if (node?.type !== "MemberExpression" || node.computed || node.property?.type !== "Identifier") {
    return null;
  }

  return node.property.name;
}

function isTestCaseCallee(callee) {
  if (callee?.type === "Identifier") {
    return TEST_CASE_FUNCTIONS.has(callee.name);
  }

  const modifier = getStaticPropertyName(callee);
  return Boolean(
    modifier &&
    TEST_CASE_MODIFIERS.has(modifier) &&
    callee.object?.type === "Identifier" &&
    TEST_CASE_FUNCTIONS.has(callee.object.name),
  );
}

function compileBoundaryPatterns(options) {
  const entries = options?.patterns ?? [];
  return entries.map((entry) => ({
    regex: new RegExp(entry.pattern),
    message: entry.message ?? `Import "${entry.pattern}" crosses a forbidden feature boundary.`,
  }));
}

export default {
  meta: {
    name: "local",
  },
  rules: {
    "no-restricted-feature-imports": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Forbid imports whose specifier matches a declared feature/layer boundary pattern. Scope the 'from' side with the override 'files' glob; list forbidden target specifiers in options.",
        },
        messages: {
          forbidden: '{{message}} (import "{{specifier}}")',
        },
        schema: [
          {
            type: "object",
            properties: {
              patterns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    pattern: { type: "string" },
                    message: { type: "string" },
                  },
                  required: ["pattern"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const patterns = compileBoundaryPatterns(context.options?.[0]);
        if (patterns.length === 0) return {};

        function check(source) {
          const specifier = source?.value;
          if (typeof specifier !== "string") return;
          for (const { regex, message } of patterns) {
            if (regex.test(specifier)) {
              context.report({
                node: source,
                messageId: "forbidden",
                data: { specifier, message },
              });
              return;
            }
          }
        }

        return {
          ImportDeclaration(node) {
            check(node.source);
          },
          ExportNamedDeclaration(node) {
            if (node.source) check(node.source);
          },
          ExportAllDeclaration(node) {
            check(node.source);
          },
          ImportExpression(node) {
            if (node.source?.type === "Literal") check(node.source);
          },
        };
      },
    },
    "test-name-should": {
      meta: {
        type: "suggestion",
        docs: {
          description: 'Require static test names to start with "should ".',
        },
        messages: {
          missingShould: 'Test name should start with "should " followed by an action verb.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isTestCaseCallee(node.callee)) return;

            const [name] = node.arguments;
            if (name?.type !== "Literal" || typeof name.value !== "string") return;
            if (name.value.startsWith("should ")) return;

            context.report({
              node: name,
              messageId: "missingShould",
            });
          },
        };
      },
    },
  },
};

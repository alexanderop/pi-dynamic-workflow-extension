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

export default {
  meta: {
    name: "local",
  },
  rules: {
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

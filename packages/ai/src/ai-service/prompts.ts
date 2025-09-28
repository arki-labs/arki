/**
 * Prompt Engineering Utilities
 * Helper functions and templates for creating effective AI prompts
 */

export interface PromptTemplate {
  template: string;
  variables: string[];
  systemPrompt?: string;
}

/**
 * Common prompt templates for various tasks
 */
export const PromptTemplates = {
  /**
   * Summarization prompt template
   */
  summarize: {
    template: `Summarize the following {contentType}:

{content}

Focus on: {focus}
Max length: {maxLength} words`,
    variables: ['contentType', 'content', 'focus', 'maxLength'],
    systemPrompt: 'You are a skilled summarizer who creates clear, concise summaries.',
  },

  /**
   * Question answering template
   */
  questionAnswer: {
    template: `Based on the following {contextType}:

{context}

Answer this question: {question}

{additionalInstructions}`,
    variables: ['contextType', 'context', 'question', 'additionalInstructions'],
    systemPrompt: 'You are a helpful assistant that provides accurate answers based on given context.',
  },

  /**
   * Code review template
   */
  codeReview: {
    template: `Review the following {language} code:

\`\`\`{language}
{code}
\`\`\`

Focus areas: {focusAreas}
Severity level: {severity}`,
    variables: ['language', 'code', 'focusAreas', 'severity'],
    systemPrompt: 'You are an experienced code reviewer who provides constructive feedback.',
  },

  /**
   * Content generation template
   */
  generateContent: {
    template: `Create {contentType} about {topic}.

Requirements:
{requirements}

Target audience: {audience}
Tone: {tone}
Length: {length}`,
    variables: ['contentType', 'topic', 'requirements', 'audience', 'tone', 'length'],
    systemPrompt: 'You are a creative content creator.',
  },

  /**
   * Data extraction template
   */
  extractData: {
    template: `Extract {dataType} from the following text:

{text}

Format: {outputFormat}
{additionalRules}`,
    variables: ['dataType', 'text', 'outputFormat', 'additionalRules'],
    systemPrompt: 'You are a data extraction specialist.',
  },
};

/**
 * Prompt builder utility class
 */
export class PromptBuilder {
  private template: string;
  private variables: Map<string, string>;
  private systemPrompt?: string;

  constructor(template?: PromptTemplate | string) {
    if (typeof template === 'string') {
      this.template = template;
      this.variables = new Map();
    } else if (template) {
      this.template = template.template;
      this.variables = new Map();
      this.systemPrompt = template.systemPrompt;
    } else {
      this.template = '';
      this.variables = new Map();
    }
  }

  /**
   * Set a variable value
   */
  setVariable(key: string, value: string): this {
    this.variables.set(key, value);
    return this;
  }

  /**
   * Set multiple variables at once
   */
  setVariables(variables: Record<string, string>): this {
    Object.entries(variables).forEach(([key, value]) => {
      this.variables.set(key, value);
    });
    return this;
  }

  /**
   * Add text to the prompt
   */
  addText(text: string): this {
    this.template += '\n\n' + text;
    return this;
  }

  /**
   * Add a section to the prompt
   */
  addSection(title: string, content: string): this {
    this.template += `\n\n## ${title}\n${content}`;
    return this;
  }

  /**
   * Add a list to the prompt
   */
  addList(title: string, items: string[]): this {
    const list = items.map(item => `- ${item}`).join('\n');
    this.template += `\n\n${title}:\n${list}`;
    return this;
  }

  /**
   * Add examples to the prompt
   */
  addExamples(examples: Array<{ input: string; output: string }>): this {
    const exampleText = examples
      .map((ex, i) => `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}`)
      .join('\n\n');

    this.template += `\n\n## Examples\n${exampleText}`;
    return this;
  }

  /**
   * Add constraints or rules
   */
  addConstraints(constraints: string[]): this {
    return this.addList('Constraints', constraints);
  }

  /**
   * Set the system prompt
   */
  setSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  /**
   * Build the final prompt
   */
  build(): { prompt: string; systemPrompt?: string } {
    let finalPrompt = this.template;

    // Replace variables in the template
    this.variables.forEach((value, key) => {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      finalPrompt = finalPrompt.replace(regex, value);
    });

    return {
      prompt: finalPrompt.trim(),
      systemPrompt: this.systemPrompt,
    };
  }

  /**
   * Create a new builder from a template
   */
  static fromTemplate(template: PromptTemplate): PromptBuilder {
    return new PromptBuilder(template);
  }

  /**
   * Create a chain-of-thought prompt
   */
  static chainOfThought(task: string): PromptBuilder {
    return new PromptBuilder()
      .addText(task)
      .addText('Let\'s approach this step-by-step:')
      .addList('Steps', [
        'First, understand the problem',
        'Break it down into smaller parts',
        'Solve each part systematically',
        'Combine the solutions',
        'Verify the result',
      ])
      .addText('Please show your reasoning for each step.');
  }

  /**
   * Create a few-shot learning prompt
   */
  static fewShot(
    task: string,
    examples: Array<{ input: string; output: string }>
  ): PromptBuilder {
    return new PromptBuilder()
      .addText(task)
      .addExamples(examples)
      .addText('Now, following the same pattern:');
  }

  /**
   * Create a role-based prompt
   */
  static withRole(role: string, task: string): PromptBuilder {
    return new PromptBuilder()
      .setSystemPrompt(`You are ${role}.`)
      .addText(task);
  }
}

/**
 * Prompt optimization utilities
 */
export class PromptOptimizer {
  /**
   * Add clarity to a prompt
   */
  static clarify(prompt: string): string {
    const clarifications = [
      'Be specific and detailed in your response.',
      'Use clear, unambiguous language.',
      'Organize your response logically.',
    ];

    return `${prompt}\n\n${clarifications.join(' ')}`;
  }

  /**
   * Add constraints to limit response
   */
  static constrain(
    prompt: string,
    constraints: {
      maxLength?: number;
      format?: string;
      tone?: string;
      avoid?: string[];
    }
  ): string {
    const parts = [prompt];

    if (constraints.maxLength) {
      parts.push(`Limit your response to ${constraints.maxLength} words.`);
    }
    if (constraints.format) {
      parts.push(`Format your response as: ${constraints.format}`);
    }
    if (constraints.tone) {
      parts.push(`Use a ${constraints.tone} tone.`);
    }
    if (constraints.avoid && constraints.avoid.length > 0) {
      parts.push(`Avoid: ${constraints.avoid.join(', ')}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Add context to improve response relevance
   */
  static addContext(
    prompt: string,
    context: {
      background?: string;
      audience?: string;
      purpose?: string;
    }
  ): string {
    const parts = [prompt];

    if (context.background) {
      parts.unshift(`Background: ${context.background}`);
    }
    if (context.audience) {
      parts.push(`Target audience: ${context.audience}`);
    }
    if (context.purpose) {
      parts.push(`Purpose: ${context.purpose}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Format prompt for better structure
   */
  static format(prompt: string): string {
    // Remove excessive whitespace
    let formatted = prompt.replace(/\n{3,}/g, '\n\n');

    // Ensure proper spacing around sections
    formatted = formatted.replace(/^(#{1,3}\s+.+)$/gm, '\n$1\n');

    // Trim and return
    return formatted.trim();
  }
}

/**
 * Prompt validation utilities
 */
export class PromptValidator {
  /**
   * Check if all required variables are provided
   */
  static validateVariables(
    template: string,
    variables: Record<string, any>
  ): { valid: boolean; missing: string[] } {
    const requiredVars = template.match(/\{(\w+)\}/g)?.map(v => v.slice(1, -1)) || [];
    const missing = requiredVars.filter(v => !(v in variables));

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Check prompt length
   */
  static checkLength(
    prompt: string,
    maxTokens = 4000
  ): { valid: boolean; estimatedTokens: number } {
    // Rough estimation: 1 token ≈ 4 characters
    const estimatedTokens = Math.ceil(prompt.length / 4);

    return {
      valid: estimatedTokens <= maxTokens,
      estimatedTokens,
    };
  }

  /**
   * Check for potential issues
   */
  static checkQuality(prompt: string): {
    issues: string[];
    suggestions: string[];
  } {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Check for vague language
    const vagueTerms = ['thing', 'stuff', 'something', 'whatever'];
    vagueTerms.forEach(term => {
      if (prompt.toLowerCase().includes(term)) {
        issues.push(`Contains vague term: "${term}"`);
        suggestions.push('Use more specific language');
      }
    });

    // Check for missing context
    if (prompt.length < 50) {
      issues.push('Prompt may be too short');
      suggestions.push('Add more context or details');
    }

    // Check for unclear instructions
    if (!prompt.includes('?') && !prompt.match(/^(create|generate|write|explain|describe|analyze)/i)) {
      suggestions.push('Consider starting with a clear action verb');
    }

    return { issues, suggestions };
  }
}
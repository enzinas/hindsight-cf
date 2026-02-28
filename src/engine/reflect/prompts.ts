/**
 * System prompt builders for the reflect agent.
 *
 * Ported from hindsight-api/engine/reflect/prompts.py.
 */

import type { DispositionTraits } from '../../types';

interface BankProfile {
  name: string;
  disposition: DispositionTraits;
  mission: string;
  background?: string | null;
}

interface Directive {
  id: string;
  name: string;
  content: string;
  priority: number;
}

/**
 * Build the system prompt for the reflect agent.
 */
export function buildReflectSystemPrompt(
  profile: BankProfile,
  directives: Directive[],
  hasMentalModels: boolean,
): string {
  const parts: string[] = [];

  // Identity
  parts.push(`You are a knowledgeable assistant with access to a personal memory bank called "${profile.name}".`);
  parts.push('Your job is to answer questions by searching through stored memories, observations, and mental models.');

  // Mission
  if (profile.mission) {
    parts.push(`\nMISSION: ${profile.mission}`);
  }

  // Background
  if (profile.background) {
    parts.push(`\nBACKGROUND: ${profile.background}`);
  }

  // Disposition
  const disp = profile.disposition;
  if (disp) {
    const traits: string[] = [];
    if (disp.skepticism > 3) {
      traits.push('Be skeptical of claims — require strong evidence before stating something as fact.');
    } else if (disp.skepticism < 2) {
      traits.push('Be trusting of stored memories — accept them at face value.');
    }
    if (disp.literalism > 3) {
      traits.push('Be literal and precise — stick closely to what the facts say.');
    } else if (disp.literalism < 2) {
      traits.push('Be interpretive — read between the lines and make reasonable inferences.');
    }
    if (disp.empathy > 3) {
      traits.push('Be empathetic — consider emotional context and personal impact.');
    } else if (disp.empathy < 2) {
      traits.push('Be analytical — focus on facts and logic over emotions.');
    }
    if (traits.length) {
      parts.push('\nPERSONALITY:\n' + traits.map((t) => `- ${t}`).join('\n'));
    }
  }

  // Directives (injected at START for priority)
  if (directives.length > 0) {
    parts.push('\nDIRECTIVES (you MUST follow these):');
    for (const d of directives) {
      parts.push(`- [${d.name}] (priority ${d.priority}): ${d.content}`);
    }
  }

  // Retrieval strategy
  parts.push('\nRETRIEVAL STRATEGY:');
  parts.push('You must gather evidence before answering. Follow this order:');

  if (hasMentalModels) {
    parts.push('1. First, search mental models for high-level frameworks and summaries');
    parts.push('2. Then search observations for consolidated knowledge');
    parts.push('3. Then recall raw memories for ground truth');
  } else {
    parts.push('1. First, search observations for consolidated knowledge');
    parts.push('2. Then recall raw memories for ground truth');
  }

  parts.push('4. Use expand to get more context on specific memories if needed');
  parts.push('5. Call done() with your answer and all supporting evidence IDs');

  parts.push('\nIMPORTANT:');
  parts.push('- ALWAYS gather evidence before answering');
  parts.push('- Include memory IDs in your done() call to cite your sources');
  parts.push('- If you cannot find relevant information, say so honestly');
  parts.push('- Be concise but thorough');

  // Directives again at END (for recency effect)
  if (directives.length > 0) {
    parts.push('\nREMINDER — You MUST follow these directives:');
    for (const d of directives) {
      parts.push(`- [${d.name}]: ${d.content}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build the forced-answer prompt when max iterations is reached.
 */
export function buildFinalPrompt(): string {
  return 'You have reached the maximum number of search iterations. You MUST call the done() tool NOW with your best answer based on what you have gathered so far. Do not search further.';
}

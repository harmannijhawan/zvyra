import { describe, it, expect } from 'vitest';
import { classifyIntent, getIntentAction } from '../electron/core/intent';

describe('Intent Classification', () => {
  describe('CHAT intents', () => {
    it('should classify simple greetings as CHAT', () => {
      const greetings = ['hi', 'hello', 'hey', 'Hi', 'HELLO', 'hey there'];
      
      greetings.forEach((greeting) => {
        const result = classifyIntent(greeting, false);
        expect(result.intent).toBe('CHAT');
        expect(result.shouldStartRun).toBe(false);
        expect(result.confidence).toBeGreaterThan(0.6);
      });
    });

    it('should classify thank you messages as CHAT', () => {
      const thanks = ['thanks', 'thank you', 'ty', 'Thanks!'];
      
      thanks.forEach((msg) => {
        const result = classifyIntent(msg, false);
        expect(result.intent).toBe('CHAT');
        expect(result.shouldStartRun).toBe(false);
      });
    });

    it('should classify affirmations as CHAT', () => {
      const affirmations = ['ok', 'okay', 'cool', 'nice', 'great', 'good'];
      
      affirmations.forEach((msg) => {
        const result = classifyIntent(msg, false);
        expect(result.intent).toBe('CHAT');
        expect(result.shouldStartRun).toBe(false);
      });
    });

    it('should classify goodbyes as CHAT', () => {
      const goodbyes = ['bye', 'goodbye'];
      
      goodbyes.forEach((msg) => {
        const result = classifyIntent(msg, false);
        expect(result.intent).toBe('CHAT');
        expect(result.shouldStartRun).toBe(false);
      });
    });

    it('should classify "how are you" as CHAT', () => {
      const result = classifyIntent('how are you?', false);
      expect(result.intent).toBe('CHAT');
      expect(result.shouldStartRun).toBe(false);
      expect(result.confidence).toBeGreaterThan(0.9);
    });
  });

  describe('QUESTION intents', () => {
    it('should classify "what is" questions', () => {
      const questions = [
        'what is SWARM?',
        'what is React?',
        'what is TypeScript?',
        'What are the features?',
      ];
      
      questions.forEach((q) => {
        const result = classifyIntent(q, false);
        expect(result.intent).toBe('QUESTION');
        expect(result.shouldStartRun).toBe(false);
        expect(result.confidence).toBeGreaterThan(0.8);
      });
    });

    it('should classify questions with question marks', () => {
      const result = classifyIntent('Can you help me understand this?', false);
      expect(result.intent).toBe('QUESTION');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should classify "tell me about" questions', () => {
      const result = classifyIntent('Tell me about React hooks', false);
      expect(result.intent).toBe('QUESTION');
      expect(result.shouldStartRun).toBe(false);
    });
  });

  describe('EXPLANATION intents', () => {
    it('should classify "how to" questions', () => {
      const questions = [
        'how to build a website',
        'how does React work?',
        'how can I improve performance?',
      ];
      
      questions.forEach((q) => {
        const result = classifyIntent(q, false);
        expect(result.intent).toBe('EXPLANATION');
        expect(result.shouldStartRun).toBe(false);
      });
    });

    it('should classify "explain" requests', () => {
      const result = classifyIntent('explain how promises work', false);
      expect(result.intent).toBe('EXPLANATION');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should classify comparison questions', () => {
      const result = classifyIntent('what is the difference between let and const?', false);
      expect(result.intent).toBe('EXPLANATION');
      expect(result.shouldStartRun).toBe(false);
    });
  });

  describe('RESEARCH intents', () => {
    it('should classify web search requests', () => {
      const searches = [
        'search for the latest React version',
        'research current web frameworks',
        'find information about Next.js',
        'look up TypeScript best practices',
      ];
      
      searches.forEach((s) => {
        const result = classifyIntent(s, false);
        expect(result.intent).toBe('RESEARCH');
        expect(result.shouldStartRun).toBe(false); // Research stays in Chat
        expect(result.confidence).toBeGreaterThan(0.8);
      });
    });

    it('should classify "what is the latest" as research', () => {
      const result = classifyIntent('what is the latest version of Node.js?', false);
      expect(result.intent).toBe('RESEARCH');
      expect(result.shouldStartRun).toBe(false);
    });
  });

  describe('BUILD intents', () => {
    it('should classify clear build requests with high confidence', () => {
      const buildRequests = [
        'build me a website',
        'build a modern sneaker store',
        'create a full-stack SaaS',
        'make an e-commerce app',
        'build a React dashboard',
        'develop a portfolio website',
      ];
      
      buildRequests.forEach((req) => {
        const result = classifyIntent(req, false);
        expect(result.intent).toBe('BUILD');
        expect(result.shouldStartRun).toBe(true);
        expect(result.confidence).toBeGreaterThan(0.7);
      });
    });

    it('should classify "create an app" as BUILD', () => {
      const result = classifyIntent('create an app for managing tasks', false);
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBe(true);
    });

    it('should classify full-stack mentions as BUILD', () => {
      const result = classifyIntent('I need a full-stack application', false);
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBe(true);
    });

    it('should NOT classify "make a sneaker store" as CHAT', () => {
      const result = classifyIntent('make a sneaker store', false);
      expect(result.intent).toBe('BUILD');
      expect(result.shouldStartRun).toBe(true);
    });
  });

  describe('CODE/DEBUG intents', () => {
    it('should classify fix requests', () => {
      const fixRequests = [
        'fix the build error',
        'debug this issue',
        'find and fix the bug',
        'solve this error',
      ];
      
      fixRequests.forEach((req) => {
        const result = classifyIntent(req, true); // With project
        expect(result.intent).toBe('DEBUG');
        expect(result.requiresProject).toBe(true);
        expect(result.shouldStartRun).toBe(true); // Should run when project exists
      });
    });

    it('should require project for debug intents', () => {
      const result = classifyIntent('fix the build error', false); // No project
      expect(result.intent).toBe('DEBUG');
      expect(result.requiresProject).toBe(true);
      expect(result.shouldStartRun).toBe(false); // Should NOT run without project
    });
  });

  describe('EDIT intents', () => {
    it('should classify file editing requests', () => {
      const editRequests = [
        'edit the README',
        'modify this file',
        'update the component',
        'refactor the code',
      ];
      
      editRequests.forEach((req) => {
        const result = classifyIntent(req, true);
        expect(result.intent).toBe('EDIT');
        expect(result.requiresProject).toBe(true);
      });
    });
  });

  describe('AUTOMATE intents', () => {
    it('should classify script/automation requests', () => {
      const automateRequests = [
        'write a script to deploy',
        'create a script that automates testing',
        'write a Node.js script that processes files',
        'automate this task',
      ];
      
      automateRequests.forEach((req) => {
        const result = classifyIntent(req, false);
        expect(result.intent).toBe('AUTOMATE');
        expect(result.shouldStartRun).toBe(true);
      });
    });
  });

  describe('AMBIGUOUS intents', () => {
    it('should classify vague short messages as AMBIGUOUS or CHAT', () => {
      const vague = ['do something', 'change it'];
      
      vague.forEach((msg) => {
        const result = classifyIntent(msg, false);
        expect(['AMBIGUOUS', 'CHAT']).toContain(result.intent);
        expect(result.shouldStartRun).toBe(false);
      });
      
      // "help" is short enough to be CHAT
      const help = classifyIntent('help', false);
      expect(help.intent).toBe('CHAT');
      expect(help.shouldStartRun).toBe(false);
    });
  });

  describe('Edge cases and critical tests', () => {
    it('should NEVER treat "hi" as a build request', () => {
      const result = classifyIntent('hi', false);
      expect(result.intent).not.toBe('BUILD');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should NEVER treat "hello" as a build request', () => {
      const result = classifyIntent('hello', false);
      expect(result.intent).not.toBe('BUILD');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should NEVER treat "what is SWARM?" as a build request', () => {
      const result = classifyIntent('what is SWARM?', false);
      expect(result.intent).not.toBe('BUILD');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should NEVER treat "thanks" as a build request', () => {
      const result = classifyIntent('thanks', false);
      expect(result.intent).not.toBe('BUILD');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should NEVER treat "explain this error" as a build request', () => {
      const result = classifyIntent('explain this error', false);
      expect(result.intent).not.toBe('BUILD');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should distinguish "how to build" (EXPLANATION) from "build me" (BUILD)', () => {
      const howTo = classifyIntent('how to build a website', false);
      expect(howTo.intent).toBe('EXPLANATION');
      expect(howTo.shouldStartRun).toBe(false);

      const buildMe = classifyIntent('build me a website', false);
      expect(buildMe.intent).toBe('BUILD');
      expect(buildMe.shouldStartRun).toBe(true);
    });

    it('should handle emoji in greetings', () => {
      const result = classifyIntent('hi 👋', false);
      expect(result.intent).toBe('CHAT');
      expect(result.shouldStartRun).toBe(false);
    });

    it('should handle case insensitivity', () => {
      const tests = [
        'HI',
        'HELLO',
        'WHAT IS SWARM',
        'BUILD ME A WEBSITE',
      ];

      tests.forEach((test) => {
        const result = classifyIntent(test, false);
        expect(result.intent).toBeDefined();
      });
    });
  });

  describe('Confidence scoring', () => {
    it('should have high confidence for obvious cases', () => {
      const obvious = [
        { text: 'hi', expectedIntent: 'CHAT' },
        { text: 'build me a website', expectedIntent: 'BUILD' },
        { text: 'what is React?', expectedIntent: 'QUESTION' },
        { text: 'search for latest news', expectedIntent: 'RESEARCH' },
      ];

      obvious.forEach(({ text, expectedIntent }) => {
        const result = classifyIntent(text, false);
        expect(result.intent).toBe(expectedIntent);
        expect(result.confidence).toBeGreaterThan(0.8);
      });
    });

    it('should have lower confidence for ambiguous cases', () => {
      const result = classifyIntent('something about websites maybe', false);
      expect(result.confidence).toBeLessThan(0.8);
    });
  });

  describe('getIntentAction', () => {
    it('should return appropriate action descriptions', () => {
      expect(getIntentAction('CHAT')).toContain('respond');
      expect(getIntentAction('BUILD')).toContain('build');
      expect(getIntentAction('QUESTION')).toContain('answer');
      expect(getIntentAction('RESEARCH')).toContain('research');
      expect(getIntentAction('AMBIGUOUS')).toContain('clarify');
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle the Delhi Sneaker Store scenario correctly', () => {
      const variations = [
        'build a Delhi sneaker store',
        'create a sneaker store website',
        'make a modern sneaker store',
      ];

      variations.forEach((v) => {
        const result = classifyIntent(v, false);
        expect(result.intent).toBe('BUILD');
        expect(result.shouldStartRun).toBe(true);
      });
    });

    it('should NOT build when user asks about building', () => {
      const questions = [
        'how would you build a sneaker store?',
        'what would you do to build a store?',
        'can you explain how to build an app?',
      ];

      questions.forEach((q) => {
        const result = classifyIntent(q, false);
        expect(result.shouldStartRun).toBe(false);
      });
    });
  });
});

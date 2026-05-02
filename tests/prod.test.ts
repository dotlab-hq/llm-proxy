import { expect, test } from "bun:test";
import { ChatOpenAI } from "@langchain/openai";

const NUM_CALLS = 20;

const llm = new ChatOpenAI( {
  model:"groq/compound",
  
  temperature: 0.7,
  apiKey: "dummy",
  configuration: {
    baseURL: "http://localhost:3000/v1",
  },
} );

test( `should respond to ${NUM_CALLS} concurrent calls`, async () => {
  const promises = Array.from( { length: NUM_CALLS }, ( _, i ) => llm.invoke( `Test ${i}` ) );

  const results = await Promise.all( promises );

  expect( results.length ).toBe( NUM_CALLS );
  expect( results[0]!.content ).toBeDefined();
}, 180000 );
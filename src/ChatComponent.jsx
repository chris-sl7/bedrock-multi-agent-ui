import useSpeechToText from './js/useSpeechToText';
import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from "react-markdown"
import rehypeRaw from 'rehype-raw'
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import Avatar from "@cloudscape-design/chat-components/avatar";
import LoadingBar from "@cloudscape-design/chat-components/loading-bar";
import LiveRegion from "@cloudscape-design/components/live-region";
import Box from "@cloudscape-design/components/box";
import {
  Container,
  Form,
  FormField,
  PromptInput,
  Button,
  Modal,
  SpaceBetween,
  TopNavigation,
  SplitPanel
} from "@cloudscape-design/components";
import PropTypes from 'prop-types';
import * as AWSAuth from '@aws-amplify/auth';
import { BedrockAgentRuntimeClient, InvokeAgentCommand } from "@aws-sdk/client-bedrock-agent-runtime";
// import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import './ChatComponent.css';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3"; 
import pako from 'pako';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { JsonViewer } from '@textea/json-viewer';

/**
 * Main chat interface component that handles message interaction with Bedrock agent
 * @param {Object} props - Component properties
 * @param {Object} props.user - Current authenticated user information
 * @param {Function} props.onLogout - Callback handler for logout action
 * @param {Function} props.onConfigEditorClick - Callback for configuration editor
 * @returns {JSX.Element} The chat interface
 */
const ChatComponent = ({ user, onLogout, onConfigEditorClick }) => {
  // dynamo
  const [dynamoDbClient, setDynamoDbClient] = useState(null);
  // s3
  const [s3Client, setS3Client] = useState(null);
  const [selectedMessageTrace, setSelectedMessageTrace] = useState(null);
  // ADD THIS NEW STATE FOR TRACES
  const [traces, setTraces] = useState([]);
  // NEW STATE FOR SPLIT PANEL
  const [splitPanelOpen, setSplitPanelOpen] = useState(true);
  // AWS Bedrock client instance for agent communication
  const [bedrockClient, setBedrockClient] = useState(null);
  // AWS Lambda client for Strands agent communication
  const [lambdaClient, setLambdaClient] = useState(null);
  // AgentCore client for AgentCore agent communication
  const [agentCoreClient, setAgentCoreClient] = useState(null);
  // Array of chat messages in the conversation
  const [messages, setMessages] = useState([]);
  // Current message being composed by the user
  const [newMessage, setNewMessage] = useState('');
  // Unique identifier for the current chat session
  const [sessionId, setSessionId] = useState(null);
  // Reference to automatically scroll to latest messages
  const messagesEndRef = useRef(null);
  // Tracks when the AI agent is processing a response
  const [isAgentResponding, setIsAgentResponding] = useState(false);
  // Controls visibility of the clear conversation modal
  const [showClearDataModal, setShowClearDataModal] = useState(false);
  // Name of the AI agent for display purposes
  const [agentName, setAgentName] = useState({ value: 'Agent' });
  // Tracks completed tasks and their explanation
  const [tasksCompleted, setTasksCompleted] = useState({ count: 0, latestRationale: '' });
  // Flag to determine if using Strands Agent
  const [isStrandsAgent, setIsStrandsAgent] = useState(false);
  // Flag to determine if using AgentCore Agent
  const [isAgentCoreAgent, setIsAgentCoreAgent] = useState(false);

  // Helper function to get the base traceId without suffixes
  const getBaseTraceId = (fullTraceId) => {
    if (!fullTraceId) return 'unknown';
    
    // Remove common suffixes like "-routing-0", "-0", etc.
    return fullTraceId.replace(/-routing-\d+$/, '').replace(/-\d+$/, '');
  };

  /**
  * Scrolls the chat window to the most recent message
  * Uses smooth scrolling behavior for better user experience
  */
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  /**
 * Shows the modal for confirming conversation clearing
 */
  const handleClearData = () => {
    setShowClearDataModal(true);
  };

  /**
  Lines added for Speech to Text functionality
   */
  const { transcript, isListening, startListening, stopListening, speechRecognitionSupported } = useSpeechToText();
  console.log('Speech Recognition Supported', speechRecognitionSupported);
  useEffect(() => {
    if (transcript) {
      setNewMessage(transcript.trim());
      scrollToBottom();
    }
  }, [transcript]);


  /**
   * Handles the confirmation action for clearing conversation data
   */
  /**
   * Handles the confirmation action for clearing conversation data
   * Clears all local storage and reloads the application
   */
  const confirmClearData = () => {
    // Clear all stored data from localStorage
    localStorage.clear();
    // Reload the application to reset state
    window.location.reload();
  };

  /**
   * Creates a new chat session with a unique identifier
   * Clears existing messages and initializes storage for the new session
   * Uses timestamp as session identifier and writes to DynamoDB
   */
  const createNewSession = useCallback(() => {
    // Generate new session ID using current timestamp
    const newSessionId = `agentcore-session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 15)}`;
    
    // Update session state
    setSessionId(newSessionId);
    
    // Clear existing messages
    setMessages([]);
    
    // Store session information in localStorage
    localStorage.setItem('lastSessionId', newSessionId);
    localStorage.setItem(`messages_${newSessionId}`, JSON.stringify([]));
    
    // Create conversation in DynamoDB if client is available
    if (dynamoDbClient) {
      const timestamp = Date.now();
      const conversationParams = {
        TableName: "Conversations",
        Item: {
          conversation_id: { S: newSessionId },
          owner_id: { S: user.username },
          creation_timestamp: { N: timestamp.toString() },
          last_updated_timestamp: { N: timestamp.toString() },
          title: { S: "New Conversation" },
          message_count: { N: "0" }
        }
      };
      
      console.log('🔍 DYNAMO - Creating conversation with params:', JSON.stringify(conversationParams, null, 2));
  
      dynamoDbClient.send(new PutItemCommand(conversationParams))
        .then(() => {
          console.log('✅ DYNAMO - Successfully created conversation in DynamoDB:', newSessionId);
          console.log('📊 DYNAMO - To find this item in DynamoDB Console:');
          console.log(`   1. Go to DynamoDB > Tables > Conversations`);
          console.log(`   2. Click "Explore table items"`);
          console.log(`   3. Search for conversation_id = "${newSessionId}"`);
        })
        .catch(error => console.error('❌ DYNAMO - Error creating conversation in DynamoDB:', error));
    } else {
      console.log('DynamoDB client not available, conversation stored only in localStorage');
    }
    
    console.log('New session created:', newSessionId);
    return newSessionId;
  }, [dynamoDbClient, user]);

  /**
   * Retrieves messages for a specific chat session from localStorage
   * @param {string} sessionId - The identifier of the session to fetch messages for
   * @returns {Array} Array of messages for the session, or empty array if none found
   */
  const fetchMessagesForSession = useCallback((sessionId) => {
    const storedMessages = localStorage.getItem(`messages_${sessionId}`);
    return storedMessages ? JSON.parse(storedMessages) : [];
  }, []);

  /**
   * Persists messages to localStorage for a specific session
   * Merges new messages with existing ones before storing
   * @param {string} sessionId - The identifier of the session to store messages for
   * @param {Array} newMessages - New messages to add to storage
   */
  const storeMessages = useCallback((sessionId, newMessages) => {
    // Retrieve existing messages for the session
    const currentMessages = fetchMessagesForSession(sessionId);
    // Merge existing and new messages
    const updatedMessages = [...currentMessages, ...newMessages];
    // Save updated message list to localStorage
    localStorage.setItem(`messages_${sessionId}`, JSON.stringify(updatedMessages));
  }, [fetchMessagesForSession]);

  /**
   * Creates a message in DynamoDB and updates the associated conversation
   * @param {Object} message - The message object to store
   * @param {string} s3TracePath - Optional path to S3 trace file
   * @returns {Promise<Object>} - Details about the created message
   */
  const createMessageInDynamoDB = async (message, s3TracePath = null) => {
    if (!dynamoDbClient) return;
    
    const timestamp = Date.now();
    const tsNanos = `${timestamp}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    
    const messageParams = {
      TableName: "Messages",
      Item: {
        conversation_id: { S: message.sessionId },
        ts_nanos: { S: tsNanos },
        message_id: { S: messageId },
        sender_type: { S: message.sender === "You" ? "human" : "assistant" },
        content: { S: message.text },
        timestamp: { N: timestamp.toString() }
      }
    };
    
    // Add S3 trace path if available
    if (s3TracePath) {
      messageParams.Item.s3_trace_path = { S: s3TracePath };
      console.log('🔗 DYNAMO - Adding S3 trace path to message:', s3TracePath);
    }
    
    console.log('🔍 DYNAMO - Creating message with params:', JSON.stringify(messageParams, null, 2));
    
    try {
      await dynamoDbClient.send(new PutItemCommand(messageParams));
      console.log('✅ DYNAMO - Message created in DynamoDB with ID:', messageId);
      console.log('📊 DYNAMO - To find this message in DynamoDB Console:');
      console.log(`   1. Go to DynamoDB > Tables > Messages`);
      console.log(`   2. Click "Explore table items"`);
      console.log(`   3. Search for conversation_id = "${message.sessionId}" and ts_nanos = "${tsNanos}"`);
      
      // Update conversation record
      const updateParams = {
        TableName: "Conversations",
        Key: {
          conversation_id: { S: message.sessionId }
        },
        UpdateExpression: "SET last_updated_timestamp = :ts, message_count = message_count + :inc",
        ExpressionAttributeValues: {
          ":ts": { N: timestamp.toString() },
          ":inc": { N: "1" }
        }
      };
      
      console.log('🔄 DYNAMO - Updating conversation with params:', JSON.stringify(updateParams, null, 2));
      
      await dynamoDbClient.send(new UpdateItemCommand(updateParams));
      console.log('✅ DYNAMO - Conversation updated in DynamoDB');
      
      return {
        messageId,
        tsNanos,
        timestamp
      };
    } catch (error) {
      console.error('❌ DYNAMO - Error writing to DynamoDB:', error);
    }
  };

  /**
   * Fetches messages for a conversation from DynamoDB
   * @param {string} conversationId - The identifier of the conversation
   * @returns {Promise<Array>} - Promise resolving to array of messages
   */
  const fetchMessagesFromDynamoDB = useCallback(async (conversationId) => {
    if (!dynamoDbClient) {
      console.log('❌ DYNAMO - No DynamoDB client available for fetching messages');
      return [];
    }
    
    try {
      const params = {
        TableName: "Messages",
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: {
          ":cid": { S: conversationId }
        },
        ScanIndexForward: true, // Sort by timestamp ascending
        ConsistentRead: true // Ensure we get the latest data
      };
      
      console.log('🔍 DYNAMO - Fetching messages for conversation:', conversationId);
      console.log('🔍 DYNAMO - Query params:', JSON.stringify(params, null, 2));
      
      // Dynamically import QueryCommand to improve initial load performance
      const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
      const startTime = Date.now();
      const response = await dynamoDbClient.send(new QueryCommand(params));
      const endTime = Date.now();
      
      console.log(`✅ DYNAMO - Found ${response.Items.length} messages in DynamoDB for conversation: ${conversationId}`);
      console.log(`⏱️ DYNAMO - Query took ${endTime - startTime}ms to complete`);
      
      if (response.Items.length > 0) {
        console.log('📋 DYNAMO - Sample message:', JSON.stringify(response.Items[0], null, 2));
        console.log('📊 DYNAMO - Message timestamps range:',
          response.Items.length > 0 ? new Date(parseInt(response.Items[0].timestamp.N)).toISOString() : 'N/A',
          'to',
          response.Items.length > 1 ? new Date(parseInt(response.Items[response.Items.length-1].timestamp.N)).toISOString() : 'N/A'
        );
      }
      
      // Check if we have any items with trace paths
      const messagesWithTraces = response.Items.filter(item => item.s3_trace_path);
      if (messagesWithTraces.length > 0) {
        console.log(`🔗 DYNAMO - ${messagesWithTraces.length}/${response.Items.length} messages have S3 trace paths`);
      }
      
      // Convert DynamoDB items to message format
      const messages = response.Items.map(item => {
        const formattedMessage = {
          text: item.content.S,
          sender: item.sender_type.S === "human" ? "You" : agentName.value,
          timestamp: new Date(parseInt(item.timestamp.N)).toISOString(),
          sessionId: item.conversation_id.S,
        };
        
        // Add optional fields if they exist
        if (item.s3_trace_path) {
          formattedMessage.s3TracePath = item.s3_trace_path.S;
        }
        
        if (item.message_id) {
          formattedMessage.messageId = item.message_id.S;
        }
        
        return formattedMessage;
      });
      
      console.log(`✅ DYNAMO - Successfully converted ${messages.length} DynamoDB items to message format`);
      return messages;
    } catch (error) {
      console.error('❌ DYNAMO - Error fetching messages from DynamoDB:', error);
      console.error('❌ DYNAMO - Error details:', {
        message: error.message,
        code: error.code,
        name: error.name,
        stack: error.stack
      });
      
      if (error.code === 'ResourceNotFoundException') {
        console.error('❌ DYNAMO - Table "Messages" does not exist. Please create it first.');
      } else if (error.code === 'AccessDeniedException') {
        console.error('❌ DYNAMO - Access denied. Check IAM permissions for Cognito role.');
      } else if (error.code === 'ThrottlingException') {
        console.error('❌ DYNAMO - Request throttled. Consider implementing exponential backoff.');
      }
      
      return [];
    }
  }, [dynamoDbClient, agentName]);

  /** 
   * Fetches the most recent conversation for the current user from DynamoDB
   * @returns {Promise<Object|null>} - Promise resolving to conversation object or null
   */
  const fetchRecentConversationFromDynamoDB = useCallback(async () => {
    if (!dynamoDbClient || !user) return null;
    
    try {
      // We need to query the GSI on owner_id to find user's conversations
      const params = {
        TableName: "Conversations",
        IndexName: "OwnerIdIndex", // Assuming this is the name of your GSI
        KeyConditionExpression: "owner_id = :owner",
        ExpressionAttributeValues: {
          ":owner": { S: user.username }
        },
        ScanIndexForward: false, // Sort by timestamp descending (most recent first)
        Limit: 1 // We only need the most recent one
      };
      
      const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
      const response = await dynamoDbClient.send(new QueryCommand(params));
      
      if (response.Items && response.Items.length > 0) {
        return response.Items[0];
      }
      
      return null;
    } catch (error) {
      console.error('Error fetching recent conversation from DynamoDB:', error);
      return null;
    }
  }, [dynamoDbClient, user]);

  /**
   * Attempts to load the last active chat session
   * First checks localStorage, then falls back to DynamoDB if not found
   * Creates a new session if no existing session is found anywhere
   * Restores messages from localStorage or DynamoDB for existing sessions
   */
  const loadExistingSession = useCallback(async () => {
    try {
      // Try to get the ID of the last active session from localStorage
      const lastSessionId = localStorage.getItem('lastSessionId');
      
      if (lastSessionId) {
        // If found in localStorage, restore the session
        console.log('Restoring session from localStorage:', lastSessionId);
        setSessionId(lastSessionId);
        
        // First check if we have messages in localStorage
        const localMessages = fetchMessagesForSession(lastSessionId);
        
        if (localMessages && localMessages.length > 0) {
          // If we have local messages, use those
          setMessages(localMessages);
          console.log(`Loaded ${localMessages.length} messages from localStorage`);
        } else if (dynamoDbClient) {
          // If no local messages but we have DynamoDB client, try fetching from there
          try {
            console.log('Fetching messages from DynamoDB for session:', lastSessionId);
            const dynamoMessages = await fetchMessagesFromDynamoDB(lastSessionId);
            
            if (dynamoMessages && dynamoMessages.length > 0) {
              setMessages(dynamoMessages);
              // Also update localStorage with these messages for future local access
              localStorage.setItem(`messages_${lastSessionId}`, JSON.stringify(dynamoMessages));
              console.log(`Loaded ${dynamoMessages.length} messages from DynamoDB`);
            } else {
              console.log('No messages found in DynamoDB for this session');
            }
          } catch (dbError) {
            console.error('Error fetching messages from DynamoDB:', dbError);
          }
        }
      } else if (dynamoDbClient) {
        // If no session in localStorage but we have DynamoDB client,
        // we could try to fetch the most recent conversation for this user
        try {
          console.log('No local session found, checking DynamoDB for recent conversations');
          const recentConversation = await fetchRecentConversationFromDynamoDB();
          
          if (recentConversation) {
            // Found a recent conversation in DynamoDB
            const conversationId = recentConversation.conversation_id.S;
            console.log('Found recent conversation in DynamoDB:', conversationId);
            
            // Set as current session
            setSessionId(conversationId);
            
            // Also update localStorage for future reference
            localStorage.setItem('lastSessionId', conversationId);
            
            // Fetch associated messages
            const dynamoMessages = await fetchMessagesFromDynamoDB(conversationId);
            
            if (dynamoMessages && dynamoMessages.length > 0) {
              setMessages(dynamoMessages);
              // Update localStorage with these messages
              localStorage.setItem(`messages_${conversationId}`, JSON.stringify(dynamoMessages));
              console.log(`Loaded ${dynamoMessages.length} messages for conversation from DynamoDB`);
            }
          } else {
            // No recent conversation found, create new session
            console.log('No recent conversations found in DynamoDB, creating new session');
            createNewSession();
          }
        } catch (dbError) {
          console.error('Error checking DynamoDB for recent conversations:', dbError);
          // Fall back to creating a new session
          createNewSession();
        }
      } else {
        // If no existing session in localStorage and no DynamoDB client,
        // create a new one
        console.log('No local session or DynamoDB client, creating new session');
        createNewSession();
      }
    } catch (error) {
      console.error('Error in loadExistingSession:', error);
      // If anything fails, create a new session as fallback
      createNewSession();
    }
  }, [createNewSession, fetchMessagesForSession, dynamoDbClient, fetchMessagesFromDynamoDB, fetchRecentConversationFromDynamoDB]);

  /**
   * Effect hook to initialize AWS Bedrock client and fetch credentials
   * Sets up the connection to AWS Bedrock service using stored configuration
   */
  useEffect(() => {
    /**
     * Fetches AWS credentials and initializes Bedrock client
     * Retrieves configuration from localStorage and establishes AWS session
     */
    const fetchCredentials = async () => {
      try {
        // Get configuration from localStorage
        const appConfig = JSON.parse(localStorage.getItem('appConfig'));
        const bedrockConfig = appConfig.bedrock;
        const strandsConfig = appConfig.strands;
        
        // Check if Strands Agent is enabled
        setIsStrandsAgent(strandsConfig && strandsConfig.enabled);
        
        // Check if AgentCore Agent is enabled
        const agentCoreConfig = appConfig.agentcore;
        setIsAgentCoreAgent(agentCoreConfig && agentCoreConfig.enabled);
        
        // Fetch AWS authentication session
        const session = await AWSAuth.fetchAuthSession();
        
        // Initialize Bedrock client if needed
        if (!strandsConfig?.enabled && !agentCoreConfig?.enabled) {
          const newBedrockClient = new BedrockAgentRuntimeClient({
            region: bedrockConfig.region,
            credentials: session.credentials
          });
          setBedrockClient(newBedrockClient);
          if (bedrockConfig.agentName && bedrockConfig.agentName.trim()) {
            setAgentName({ value: bedrockConfig.agentName });
          }
        } 

        // Initialize Lambda client for Strands Agent
        else if (strandsConfig && strandsConfig.enabled && !agentCoreConfig?.enabled) {
          const newLambdaClient = new LambdaClient({
            region: strandsConfig.region,
            credentials: session.credentials
          });
          setLambdaClient(newLambdaClient);
          if (strandsConfig.agentName && strandsConfig.agentName.trim()) {
            setAgentName({ value: strandsConfig.agentName });
          }
        }

        const newDynamoDbClient = new DynamoDBClient({
          region: 'us-east-1', // Make sure to use the correct region
          credentials: session.credentials
        });
        const docClient = DynamoDBDocumentClient.from(newDynamoDbClient);
        setDynamoDbClient(docClient);

        const newS3Client = new S3Client({
          region: 'us-east-1',
          credentials: session.credentials
        });
        setS3Client(newS3Client);

        // Initialize AgentCore client if enabled
        if (agentCoreConfig && agentCoreConfig.enabled && agentCoreConfig.region) {
          const newAgentCoreClient = new BedrockAgentCoreClient({
            region: agentCoreConfig.region,
            credentials: session.credentials
          });
          setAgentCoreClient(newAgentCoreClient);
          if (agentCoreConfig.agentName && agentCoreConfig.agentName.trim()) {
            setAgentName({ value: agentCoreConfig.agentName });
          }
        }
      } catch (error) {
        console.error('Error fetching credentials:', error);
      }
    };

    fetchCredentials();
  }, []);

  useEffect(() => {
    if ((bedrockClient || lambdaClient || agentCoreClient) && !sessionId) {
      loadExistingSession();
    }
  }, [bedrockClient, lambdaClient, agentCoreClient, sessionId, loadExistingSession]);

  /**
   * Effect hook to scroll to latest messages
   * Triggered whenever messages array is updated
   */
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // For the useEffect
  useEffect(() => {
    if (selectedMessageTrace !== null && messages[selectedMessageTrace]) {
      const message = messages[selectedMessageTrace];
      console.log('Viewing traces for message:', message);
      
      // Clear current traces
      setTraces([]);
      
      // Use traces attached directly to message
      if (message.traces && message.traces.length > 0) {
        console.log(`✅ TRACE - Using ${message.traces.length} traces stored directly with message`);
        
        // Sort traces by timestamp to ensure chronological order
        const sortedTraces = [...message.traces].sort((a, b) => 
          new Date(a.eventTime) - new Date(b.eventTime)
        );
        
        setTraces(sortedTraces);
      } else {
        console.log('⚠️ TRACE - No traces available for this message');
      }
    }
  }, [selectedMessageTrace, messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Only proceed if we have a message and active session
    if (newMessage.trim() && sessionId) {
      const appConfig = JSON.parse(localStorage.getItem('appConfig'));
      
      // Clear input field
      setNewMessage('');
      // Create message object with user information
      const userMessage = { 
        text: newMessage, 
        sender: "You",
        timestamp: new Date().toISOString(),
        sessionId: sessionId
      };
      
      // Add user message to UI immediately
      setMessages(prevMessages => [...prevMessages, userMessage]);
      // Store user message in DynamoDB
      await createMessageInDynamoDB(userMessage);
      
      setIsAgentResponding(true); // Set to true when starting to wait for response
      
      // Array to collect traces during response
      const messageTraces = [];

      try {
        let agentMessage;
        let response;
        
        // Handle Bedrock Agent
        if (!isStrandsAgent && bedrockClient) {
          const bedrockConfig = appConfig.bedrock;
          const sessionAttributes = {
            aws_session: await AWSAuth.fetchAuthSession()
          };

          const command = new InvokeAgentCommand({
            agentId: bedrockConfig.agentId,
            agentAliasId: bedrockConfig.agentAliasId,
            sessionId: sessionId,
            endSession: false,
            enableTrace: true,
            inputText: newMessage,
            promptSessionAttributes: sessionAttributes
          });

          let completion = "";
          response = await bedrockClient.send(command);

          if (response.completion === undefined) {
            throw new Error("Completion is undefined");
          }

          for await (const chunkEvent of response.completion) {
            if (chunkEvent.trace) {
              console.log("Trace: ", chunkEvent.trace);
              
              // Store trace object directly
              messageTraces.push(chunkEvent.trace);
              
              // Log trace types for debugging
              if (chunkEvent.trace.trace?.routingClassifierTrace) {
                console.log("📍 ROUTING TRACE DETECTED");
              }
              if (chunkEvent.trace.trace?.orchestrationTrace) {
                console.log("🎯 ORCHESTRATION TRACE DETECTED");
              }
              if (chunkEvent.trace.trace?.postProcessingTrace) {
                console.log("🔄 POST-PROCESSING TRACE DETECTED");
              }

              tasksCompleted.count++;
              if (typeof (chunkEvent.trace.trace.failureTrace) !== 'undefined') {
                throw new Error(chunkEvent.trace.trace.failureTrace.failureReason);
              }

              if (chunkEvent.trace?.trace?.orchestrationTrace?.rationale?.text) {
                tasksCompleted.latestRationale = chunkEvent.trace.trace.orchestrationTrace.rationale.text;
                scrollToBottom();
              }
              setTasksCompleted({ ...tasksCompleted });

            } else if (chunkEvent.chunk) {
              const chunk = chunkEvent.chunk;
              const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
              completion += decodedResponse;
            }
          }

          console.log('Full completion:', completion);
          
          // Create agent message with traces included
          agentMessage = { 
            text: completion, 
            sender: agentName.value,
            timestamp: new Date().toISOString(),
            sessionId: sessionId,
            traces: messageTraces // Store traces with the message
          };
        } 
        // Handle Strands Agent (unchanged)
        else if (isStrandsAgent && lambdaClient) {
          // Existing Strands agent code
          const strandsConfig = appConfig.strands;
          
          // Prepare payload for Lambda function
          const payload = {
            query: newMessage
          };
          
          // Extract Lambda function name from ARN
          const lambdaArn = strandsConfig.lambdaArn;
          
          const command = new InvokeCommand({
            FunctionName: lambdaArn,
            Payload: JSON.stringify(payload),
            InvocationType: 'RequestResponse'
          });
          
          response = await lambdaClient.send(command);
          
          // Process Lambda response
          const responseBody = new TextDecoder().decode(response.Payload);
          const parsedResponse = JSON.parse(responseBody);
          
          console.log('Lambda response:', parsedResponse);
          
          // Extract the response text from the Lambda result
          let responseText;
          if (parsedResponse.body) {
            const body = JSON.parse(parsedResponse.body);
            responseText = body.response;
          } else if (parsedResponse.response) {
            responseText = parsedResponse.response;
          } else {
            responseText = "Sorry, I couldn't process your request.";
          }
          
          agentMessage = { 
            text: responseText, 
            sender: agentName.value,
            timestamp: new Date().toISOString(),
            sessionId: sessionId
          };
        }
        // Handle AgentCore Agent (unchanged)
        else if (isAgentCoreAgent && agentCoreClient) {
          // Existing AgentCore agent code
          const agentCoreConfig = appConfig.agentcore;
          
          const command = new InvokeAgentRuntimeCommand({
            agentRuntimeArn: agentCoreConfig.agentArn,
            runtimeSessionId: sessionId,
            payload: JSON.stringify({ prompt: newMessage })
          });

          response = await agentCoreClient.send(command);
          
          // Handle ReadableStream response
          let responseBody = '';
          if (response.response && response.response.getReader) {
            const reader = response.response.getReader();
            const decoder = new TextDecoder();
            let done = false;
            
            while (!done) {
              const { value, done: streamDone } = await reader.read();
              done = streamDone;
              if (value) {
                responseBody += decoder.decode(value, { stream: true });
              }
            }
          } else {
            responseBody = response.response || '';
          }
          
          console.log('AgentCore raw response:', responseBody);
          
          const parsedResponse = JSON.parse(responseBody);
          const responseText = parsedResponse.result || "Sorry, I couldn't process your request.";
          agentMessage = { 
            text: responseText, 
            sender: agentName.value,
            timestamp: new Date().toISOString(),
            sessionId: sessionId
          };
        } else {
          throw new Error("No agent client available");
        }

        // Still create S3 path for reference/backward compatibility
        let s3TracePath = null;
        if (!isStrandsAgent && bedrockClient && response) {
          // Get message date from timestamp (already in UTC format)
          const messageDate = new Date(agentMessage.timestamp);
          
          // Extract date components using Eastern Time to match AWS's log structure
          const easternDate = new Date(messageDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
          const year = easternDate.getFullYear();
          const month = String(easternDate.getMonth() + 1).padStart(2, '0');
          const day = String(easternDate.getDate()).padStart(2, '0');
          const hour = String(easternDate.getHours()).padStart(2, '0');
          
          // Just store the folder path
          s3TracePath = `bedrock-invocations/main/AWSLogs/592135149261/BedrockModelInvocationLogs/us-east-1/${year}/${month}/${day}/${hour}/`;
          
          console.log('⚠️ TRACE - Using folder path for compatibility:', s3TracePath);
          console.log('📅 TRACE - Using message UTC timestamp:', messageDate.toISOString());
          console.log('📅 TRACE - Converted to Eastern Time for path:', 
            `${year}-${month}-${day} ${hour}:00 ET`);
        }

        // Store agent message in DynamoDB with trace path
        await createMessageInDynamoDB(agentMessage, s3TracePath);
        
        // Update UI with agent message
        setMessages(prevMessages => [...prevMessages, agentMessage]);
        
        // Also store messages in localStorage for backward compatibility
        storeMessages(sessionId, [userMessage, agentMessage]);

      } catch (err) {
        console.error('Error invoking agent:', err);

        let errReason = "**"+String(err).toString()+"**";
        
        const errorMessage = { 
          text: `An error occurred while processing your request:\n${errReason}`, 
          sender: 'agent',
          timestamp: new Date().toISOString(),
          sessionId: sessionId
        };
        
        // Update UI with error message
        setMessages(prevMessages => [...prevMessages, errorMessage]);
        
        // Store error message in DynamoDB and localStorage
        await createMessageInDynamoDB(errorMessage);
        storeMessages(sessionId, [userMessage, errorMessage]);
        
      } finally {
        setIsAgentResponding(false); // Set to false when response is received
        setTasksCompleted({ count: 0, latestRationale: '' });
      }
    }
  };

  const handleLogout = async () => {
    try {
      await AWSAuth.signOut();
      onLogout();
    } catch (error) {
      console.error('Error signing out: ', error);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden' }}>
      {/* Left side - Chat (40% width) */}
      <div style={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopNavigation
          identity={{
            href: "#",
            title: `Chat with ${agentName.value}`,
          }}
          utilities={[
            //This is the button to start a new conversation
            {
              type: "button",
              iconName: "add-plus",
              title: "Start a new conversation",
              ariaLabel: "Start a new conversation",
              disableUtilityCollapse: true,
              onClick: () => createNewSession()
            },
            //This is the settings handler
            {
              type: "menu-dropdown",
              iconName: "settings",
              ariaLabel: "Settings",
              title: "Settings",
              disableUtilityCollapse: true,
              onItemClick: ({ detail }) => {
                switch (detail.id) {
                  case "edit-settings":
                    onConfigEditorClick();
                    break;
                  case "clear-settings":
                    handleClearData();
                    break;
                }
              },
              items: [
                {
                  id: "clear-settings",
                  type: "button",
                  iconName: "remove",
                  text: "Clear settings and local storage",
                },
                {
                  id: "edit-settings",
                  text: "Edit Settings",
                  iconName: "edit",
                  type: "icon-button",
                }
              ]
            },
            //This is the user session menu options
            {
              type: "menu-dropdown",
              text: user.username,
              iconName: "user-profile",
              title: user.username,
              ariaLabel: "User",
              disableUtilityCollapse: true,
              onItemClick: ({ detail }) => {
                switch (detail.id) {
                  case "logout":
                    handleLogout();
                    break;
                }
              },
              items: [
                {
                  id: "logout",
                  text: "Logout",
                  iconName: "exit",
                  type: "icon-button",
                }
              ]
            }
          ]}
        />
        
        <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
          {messages.map((message, index) => (
            <div key={index}>
              <ChatBubble
                ariaLabel={`${message.sender} message`}
                type={message.sender === user.username ? "outgoing" : "incoming"}
                avatar={
                  <Avatar
                    ariaLabel={message.sender}
                    tooltipText={message.sender}
                    color={message.sender === user.username ? "default" : "gen-ai"}
                    initials={message.sender.substring(0, 2).toUpperCase()}
                  />
                }
              >
                {message.text.split('\n').map((line, i) => (
                  <ReactMarkdown
                    key={'md-rendering' + i}
                    rehypePlugins={[rehypeRaw]}
                  >
                    {line}
                  </ReactMarkdown>
                ))}
                {/* ADD THIS BUTTON AFTER THE MARKDOWN RENDERING */}
                {message.sender === agentName.value && (
                  <button
                    onClick={() => {
                      // If clicking the same message, toggle off
                      if (selectedMessageTrace === index) {
                        setSelectedMessageTrace(null);
                        setTraces([]);
                      } else {
                        // Otherwise, show this message's traces
                        setSelectedMessageTrace(index);
                      }
                    }}
                    style={{ 
                      marginTop: '8px', 
                      background: 'none',
                      border: 'none',
                      color: '#0073bb',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      padding: '4px 0',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    {selectedMessageTrace === index ? (
                      <>
                        Hide Trace <span style={{ marginLeft: '4px', fontSize: '14px' }}>▲</span>
                      </>
                    ) : (
                      <>
                        View Trace <span style={{ marginLeft: '4px', fontSize: '14px' }}>▼</span>
                      </>
                    )}
                  </button>
                )}
              </ChatBubble>
            </div>
          ))}
          <div ref={messagesEndRef} />
          {isAgentResponding && (
            <LiveRegion>
              <Box
                margin={{ bottom: "xs", left: "l" }}
              >
                {!isStrandsAgent && tasksCompleted.count > 0 && (
                  <div style={{ 
                    backgroundColor: "rgba(255, 255, 255, 0.9)", 
                    padding: "8px 12px", 
                    borderRadius: "4px", 
                    color: "#333333", 
                    fontWeight: "500",
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)"
                  }}>
                    <strong>{agentName.value} is working on your request | Tasks completed ({tasksCompleted.count})</strong>
                    <br />
                    <i>{tasksCompleted.latestRationale}</i>
                  </div>
                )}
                {isStrandsAgent && (
                  <div style={{ 
                    backgroundColor: "rgba(255, 255, 255, 0.9)", 
                    padding: "8px 12px", 
                    borderRadius: "4px", 
                    color: "#333333", 
                    fontWeight: "500",
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)"
                  }}>
                    <strong>{agentName.value} is processing your request...</strong>
                  </div>
                )}
                <LoadingBar variant="gen-ai" />
              </Box>
            </LiveRegion>
          )}
        </div>
        
        <div style={{ padding: '20px', borderTop: '1px solid #d5dbdb' }}>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                onClick={isListening ? stopListening : startListening}
                title={isListening ? "Stop Listening" : "Start Listening"}
                className="mic-button"
                hidden={!speechRecognitionSupported}
                style={{ flexShrink: 0 }}
              >
                {isListening ? (
                  <svg xmlns="http://www.w3.org/2000/svg" height="28" width="28" fill="red" viewBox="0 0 24 24">
                    <path d="M12 14q-1.25 0-2.125-.875T9 11V5q0-1.25.875-2.125T12 2q1.25 0 2.125.875T15 5v6q0 1.25-.875 2.125T12 14Zm-1 7v-3.1q-2.875-.35-4.437-2.35Q5 13.55 5 11h2q0 2.075 1.463 3.538Q9.925 16 12 16q2.075 0 3.538-1.462Q17 13.075 17 11h2q0 2.55-1.563 4.55-1.562 2-4.437 2.35V21Z" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" height="28" width="28" fill="black" viewBox="0 0 24 24">
                    <path d="M12 14q-1.25 0-2.125-.875T9 11V5q0-1.25.875-2.125T12 2q1.25 0 2.125.875T15 5v6q0 1.25-.875 2.125T12 14Zm-1 7v-3.1q-2.875-.35-4.437-2.35Q5 13.55 5 11h2q0 2.075 1.463 3.538Q9.925 16 12 16q2.075 0 3.538-1.462Q17 13.075 17 11h2q0 2.55-1.563 4.55-1.562 2-4.437 2.35V21Z" />
                  </svg>
                )}
              </button>
              <div style={{ flex: 1 }}>
                <PromptInput
                  type='text'
                  value={newMessage}
                  onChange={({ detail }) => setNewMessage(detail.value)}
                  placeholder='Type your question here...'
                  actionButtonAriaLabel="Send message"
                  actionButtonIconName="send"
                />
              </div>
            </div>
          </form>
        </div>
        
        {/* Clear Data Confirmation Modal */}
        <Modal
          onDismiss={() => setShowClearDataModal(false)}
          visible={showClearDataModal}
          header="Confirm clearing data"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowClearDataModal(false)}>Cancel</Button>
                <Button variant="primary" onClick={confirmClearData}>Ok</Button>
              </SpaceBetween>
            </Box>
          }
        >
          <strong>This action cannot be undone.</strong> Configuration for this application will be deleted along with the chat history with {agentName.value}. Do you want to continue?
        </Modal>
      </div>
      
      {/* Right side - Traces Panel */}
      <div style={{ flex: '0 0 60%', borderLeft: '1px solid #d5dbdb', overflow: 'auto', backgroundColor: '#fafafa' }}>
        <div style={{ padding: '16px' }}>
          {selectedMessageTrace !== null && messages[selectedMessageTrace] ? (
            <>
              <h3>Trace Events ({traces.length})</h3>
              
              {/* Display traces in flat chronological order */}
              {traces.map((trace, index) => (
                <div key={index} style={{ 
                  marginBottom: '16px', 
                  marginTop: '16px',
                  padding: '12px', 
                  backgroundColor: 'white', 
                  border: '1px solid #d5dbdb', 
                  borderRadius: '4px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                }}>
                  {/* Trace header with continuous numbering */}
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderBottom: '1px solid #000000',
                    paddingBottom: '8px',
                    marginBottom: '12px',
                    color: '#000000',
                    fontSize: '16px',
                    fontWeight: 'bold'
                  }}>
                    <div>Trace {index + 1}</div>
                    <div><strong>Trace Type:</strong> {Object.keys(trace.trace || {})[0] || 'unknown'}</div>
                  </div>

                  {/* Basic metadata with Copy button */}
                  <div style={{ 
                    fontSize: '13px', 
                    color: '#333', 
                    marginBottom: '12px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '8px'
                  }}>
                    <div>
                      <strong>Agent:</strong> {trace.agentId}
                    </div>
                    <div>
                      <strong>Time:</strong> {new Date(trace.eventTime).toLocaleTimeString()}
                    </div>
                    <div style={{ width: '100%', marginTop: '8px' }}>
                      <button 
                        onClick={(e) => {
                          navigator.clipboard.writeText(JSON.stringify(trace, null, 2));
                          
                          // Create temporary success indicator
                          const button = e.target;
                          const originalText = button.innerText;
                          button.innerText = "✓ Copied";
                          button.style.backgroundColor = "#28a745"; // Success green
                          
                          // Reset button after 1.5 seconds
                          setTimeout(() => {
                            button.innerText = originalText;
                            button.style.backgroundColor = "#0073bb"; // Original blue
                          }, 1500);
                        }}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: '#0073bb',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: 'bold',
                          transition: 'background-color 0.3s ease' // Smooth transition for color change
                        }}
                      >
                        Copy JSON
                      </button>
                    </div>
                  </div>
                  
                  {/* JSON Viewer with collapsible UI */}
                  <details open>
                    <summary style={{ 
                      cursor: 'pointer', 
                      padding: '8px 12px', 
                      fontSize: '14px', 
                      fontWeight: 'bold',
                      userSelect: 'none',
                      outline: 'none',
                      backgroundColor: '#f0f0f0', 
                      border: '1px solid #ccc',
                      borderRadius: '4px',
                      color: '#333',
                      display: 'flex',
                      alignItems: 'center'
                    }}>
                      <span style={{ marginRight: '6px' }}>▼</span> Trace Details
                    </summary>
                    <div style={{ marginTop: '8px', textAlign: 'left' }}>
                      <JsonViewer
                        value={trace}
                        rootName={false}
                        theme="dark"
                        displaySize={false}
                        displayDataTypes={false}
                        defaultInspectDepth={2}
                        enableClipboard
                        style={{
                          textAlign: 'left',
                          fontFamily: 'monospace',
                          fontSize: '14px',
                          padding: '12px',
                          borderRadius: '4px'
                        }}
                      />
                    </div>
                  </details>
                </div>
              ))}
            </>
          ) : (
            <div style={{ padding: '16px', color: '#666', fontStyle: 'italic' }}>
              No traces selected. Click "View Trace" on an agent message to see trace data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

ChatComponent.propTypes = {
  user: PropTypes.object.isRequired,
  onLogout: PropTypes.func.isRequired,
  onConfigEditorClick: PropTypes.func.isRequired
};

export default ChatComponent;

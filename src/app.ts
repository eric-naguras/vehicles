/********************************************************************/
/* For simplicity business rules and infrastructure codes is combined 
/* into a single file. Nomally these would be separated
/* Also, some errors could be a bit nicer */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import express from 'express'

// If you’re applying via upwork, please add ‘shake it baby’ to your application.

// Nomally these env vars come from a secrets manager but this is just a demo
const SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqbGZ4eWx5ZG9pa2dhcnFhamxrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwNDMzMzkzMywiZXhwIjoyMDE5OTA5OTMzfQ.MtqxsESKDJV3NIVBnYdYjJNYaSCF3LBSm2xKW8uQzhw'
const SUPABASE_URL = 'https://vjlfxylydoikgarqajlk.supabase.co'

const app = express()
const port = 3000

export type CheckParamsFunction = (
  start: string | undefined,
  end: string | undefined
) => {
  error: string | undefined
}

type EventData = {
  event: string // If you want to make it really nice provide the event types that are accepted
  from: number
  to: number
}

type GetDataReturnType = { error: string } | EventData[]

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
})

app.use(express.json())

// Endpoint is only for responding when no vehicleId is provided
app.get('/status/vehicles/', (req, res) => {
  return res.status(400).json({ error: 'Vehicle id is required.' })
})

// endpoint for status/vehicleId with start and end parameters
app.get('/status/vehicles/:vehicleId', async (req, res) => {
  const { vehicleId } = req.params
  const start = req.query.start ? String(req.query.start) : undefined;
  const end = req.query.end ? String(req.query.end) : undefined;

  // Check params
  const errResult = checkParams(start, end)
  if (errResult.error) {
    return res.status(400).json({ error: errResult.error })
  }

  //Get the data from the database
  const events = await getData(vehicleId, start ?? '', end ?? '')
  if ('error' in events) {
    return res.status(400).json({ error: events.error })
  }

  res.json(events)
})

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`)
})

export const checkParams: CheckParamsFunction = (start, end) => {
  let errorMessage = ''

  // Check for the presence of start and end.

  if (!start) {
    errorMessage += errorMessage ? ' ' : '' // Add a space if there's already an error message.
    errorMessage += 'Start date is required.'
  }

  if (!end) {
    errorMessage += errorMessage ? ' ' : '' // Add a space if there's already an error message.
    errorMessage += 'End date is required.'
  }

  if (errorMessage) {
    return {error: errorMessage}
  }
  
  // Check that start is less than end
  const startDate = new Date(parseInt(start as string))
  const endDate = new Date(parseInt(end as string))

  if (isNaN(startDate.getTime())) {
    errorMessage += 'Invalid start date format. Please use a valid date format.'
  }

  if (isNaN(endDate.getTime())) {
    errorMessage += errorMessage ? ' ' : '' // Add a space if there's already an error message.
    errorMessage += 'Invalid end date format. Please use a valid date format.'
  }

  if (startDate >= endDate) {
    errorMessage = 'Start date must be less than end date.'
  }

  return { error: errorMessage ? errorMessage : undefined }
}
export const getData = async (vehicleId: string, start: string, end: string): Promise<GetDataReturnType> => {
  const startDate = new Date(parseInt(start as string))
  const endDate = new Date(parseInt(end as string))

  // First, get the latest event before the startDate
  // We do this in a separate query to save reources
  // Both queries could be combined but that could return a lot 
  // more records that are before the start date
  const { data: lastEventBeforeStart, error: lastEventError } = await sb
    .from('events')
    .select('timestamp, event')
    .eq('vehicleId', vehicleId)
    .lt('timestamp', startDate.toISOString())
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastEventError) {
    return { error: lastEventError.message }
  }

  const { data: vehicleEvents, error } = await sb
    .from('events')
    .select('timestamp, event')
    .eq('vehicleId', vehicleId)
    .gte('timestamp', startDate.toISOString())
    .lte('timestamp', endDate.toISOString())
    .order('timestamp', { ascending: true })

  if (error) {
    return { error: error.message }
  }

  if (vehicleEvents.length === 0) {
    return [{ event: 'no_data', from: new Date(startDate).getTime(), to: new Date(endDate).getTime() }]
  }

  // The requirements are unclear about this.
  // If there’s no logged events before the startDate, first interval must contain ‘no_data’ in the ‘event’ field
  // This would mean that you would override an event with 'no_data'
  // That doesn't seem right to me so I chose to add an event with type 'no_data'
  // In a real environment this should be discussed with the stakeholders
  const lastBeforeEvent: { event: string; from: number; to: number } = {
    event: lastEventBeforeStart ? lastEventBeforeStart.event : 'no_data',
    from: new Date(startDate).getTime(),
    to: new Date(vehicleEvents[0].timestamp).getTime()
  }

  let previousTimestamp = lastBeforeEvent.to
  let previousEvent = lastBeforeEvent.event
  const mappedEvents: EventData[] = []

  // Map the events from the database to the required object format
  vehicleEvents.forEach((event, index) => {
    const currentTimestamp = new Date(event.timestamp).getTime()
    if (event.event === previousEvent) {
      // If the event is the same as the previous one, extend the 'to' timestamp
      mappedEvents[mappedEvents.length - 1].to = currentTimestamp
    } else {
      // If the event is different, push a new event to the array
      const eventData: EventData = {
        event: event.event,
        from: previousTimestamp,
        to: currentTimestamp
      }
      mappedEvents.push(eventData)
      previousEvent = event.event // Update the previous event for the next iteration
    }
    previousTimestamp = currentTimestamp // Update the previous timestamp for the next iteration

    // If this is the last event, fix the 'to' timestamp to match the endDate
    if (index === vehicleEvents.length - 1) {
      mappedEvents[mappedEvents.length - 1].to = endDate.getTime()
    }
  })

  const combinedEvents: EventData[] = [lastBeforeEvent, ...mappedEvents]

  return combinedEvents
}

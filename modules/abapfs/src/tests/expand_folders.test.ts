// this will connect to a real server, and mostly rely on abapgit as sample data
// tests might brek with future versions of abapgit

import { ADTClient } from "abap-adt-api"
import { isFolder, AFsService, createRoot, isAbapFile } from ".."

const getRoot = () => {
  const {
    ADT_SYSTEMID = "",
    ADT_URL = "",
    ADT_USER = "",
    ADT_PASS = ""
  } = process.env
  if (ADT_URL && ADT_USER && ADT_PASS) {
    const client = new ADTClient(ADT_URL, ADT_USER, ADT_PASS)
    const service = new AFsService(client)
    return createRoot(`adt_${ADT_SYSTEMID}`, service)
  } else
    throw new Error("Please set reuired environment variables in setenv.js")
}

test("class in $ABAPGIT", async () => {
  const root = getRoot()
  const clas = await root.getNodeAsync(
    "/$TMP/$ABAPGIT/Source Code Library/Classes/ZCL_ABAPGIT_AUTH"
  )
  expect(isFolder(clas)).toBe(true)
  let main = root.getNode(
    "/$TMP/$ABAPGIT/Source Code Library/Classes/ZCL_ABAPGIT_AUTH/ZCL_ABAPGIT_AUTH.clas.abap"
  )
  expect(main).toBeUndefined()
  main = await root.getNodeAsync(
    "/$TMP/$ABAPGIT/Source Code Library/Classes/ZCL_ABAPGIT_AUTH/ZCL_ABAPGIT_AUTH.clas.abap"
  )
  expect(isAbapFile(main)).toBe(true)
  const definitions = root.getNode(
    "/$TMP/$ABAPGIT/Source Code Library/Classes/ZCL_ABAPGIT_AUTH/ZCL_ABAPGIT_AUTH.clas.locals_def.abap"
  )
  expect(isAbapFile(definitions)).toBe(true)
})
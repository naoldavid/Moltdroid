package com.moltdroid

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import com.facebook.react.bridge.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SQLiteBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "SQLiteBridgeModule"

    private val databases = mutableMapOf<String, SQLiteDatabase>()

    private fun getDb(dbPath: String): SQLiteDatabase {
        return databases.getOrPut(dbPath) {
            File(dbPath).parentFile?.mkdirs()
            SQLiteDatabase.openOrCreateDatabase(dbPath, null)
        }
    }

    @ReactMethod
    fun exec(dbPath: String, sql: String, promise: Promise) {
        try {
            val db = getDb(dbPath)
            sql.split(";").map { it.trim() }.filter { it.isNotEmpty() }.forEach { stmt ->
                db.execSQL(stmt)
            }
            promise.resolve("OK")
        } catch (e: Exception) {
            promise.reject("SQLITE_ERROR", e.message ?: "Unknown error")
        }
    }

    @ReactMethod
    fun query(dbPath: String, sql: String, promise: Promise) {
        try {
            val db = getDb(dbPath)
            val cursor = db.rawQuery(sql, null)
            val result = JSONArray()
            while (cursor.moveToNext()) {
                val row = JSONObject()
                for (i in 0 until cursor.columnCount) {
                    val colName = cursor.getColumnName(i)
                    when (cursor.getType(i)) {
                        Cursor.FIELD_TYPE_INTEGER -> row.put(colName, cursor.getLong(i))
                        Cursor.FIELD_TYPE_FLOAT   -> row.put(colName, cursor.getDouble(i))
                        Cursor.FIELD_TYPE_NULL    -> row.put(colName, JSONObject.NULL)
                        else                      -> row.put(colName, cursor.getString(i))
                    }
                }
                result.put(row)
            }
            cursor.close()
            promise.resolve(result.toString())
        } catch (e: Exception) {
            promise.reject("SQLITE_ERROR", e.message ?: "Unknown error")
        }
    }

    @ReactMethod
    fun closeDb(dbPath: String, promise: Promise) {
        databases[dbPath]?.close()
        databases.remove(dbPath)
        promise.resolve("OK")
    }
}

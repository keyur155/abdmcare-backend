import logger from "@common/config/logger";
import { rethrowServiceError } from "@common/utils/serviceErrors";


export class NhcxService {
   
    async registerHospital(id){

       try {
        
         const data={}
         return {
         success: true,
         data: data,
         message: 'Hospital plan updated successfully',
       };
       } catch (error) {
        logger.error('Failed to update provider', error);
        rethrowServiceError(error);
       }

    }
}